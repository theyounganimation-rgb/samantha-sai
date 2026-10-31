import AVFoundation
import Foundation
import UIKit

/// Owns the live call outside WebKit. All mutable call state is confined to the main queue.
final class NativeVoiceCall: NSObject, URLSessionWebSocketDelegate {
    var onEvent: (([String: Any]) -> Void)?
    private(set) var active = false
    private(set) var state = "idle"
    private(set) var startedAt: Double = 0
    private let audioApplication = AVAudioApplication.shared
    /// October 27 (Owner): calls run on the ElevenLabs realtime agent; in that mode this socket carries control, transcripts and
    /// awareness while the agent connection (WebRTC) carries the audio. The orb, mute, interrupt and end buttons work unchanged.
    private var elevenMode = false
    private var incomingInvitationID: String?
    private lazy var eleven: ElevenAgentBridge = MainActor.assumeIsolated {
        let bridge = ElevenAgentBridge()
        bridge.relay = { [weak self] item in self?.send(item) }
        bridge.emit = { [weak self] item in self?.emit(item, retain: (item["type"] as? String) != "native_level") }
        return bridge
    }
    /// NativeVoiceCall runs on the main queue; the bridge is main-actor isolated.
    private func withEleven(_ body: @MainActor (ElevenAgentBridge) -> Void) { MainActor.assumeIsolated { body(eleven) } }
    private lazy var systemCall: SystemCallControls = {
        let call = SystemCallControls()
        call.configureAudio = { [weak self] in try self?.activateAudioSession() }
        call.audioActivated = { [weak self] in
            guard let self, self.active else { return }
            self.suspended = false
            do { try self.configureAudio() }
            catch { self.traceAudio("callkit_audio_pending", error: error); self.scheduleAudioRecovery() }
        }
        call.audioDeactivated = { [weak self] in
            guard let self, self.active else { return }
            self.suspended = true; self.recoveryWork?.cancel(); self.recovery.reset()
            self.interrupt(); self.engine?.pause()
            self.emit(["type": "state", "state": "Call interrupted by iOS"])
        }
        call.applyMute = { [weak self] value in try self?.applyInputMute(value) }
        call.ended = { [weak self] in self?.stop() }
        call.failed = { [weak self] error in
            self?.traceAudio("system_call_failed", error: error)
            self?.fail("The iPhone could not complete the call control. Please reconnect.")
        }
        call.trace = { [weak self] event in self?.traceAudio(event) }
        return call
    }()
    private var muteNotifications = 0
    private var microphoneBytesWhileMuted = 0
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var captureFormat: AVAudioFormat?
    private var audioGeneration = UUID()
    private var recovery = NativeAudioRecovery()
    private var recoveryWork: DispatchWorkItem?
    private var audioErrors: [[String: Any]] = []
    private var audioEvents: [[String: Any]] = []
    private var audioProbe = false
    private var probeStarted = false
    private var player: AVAudioPlayerNode?
    private var generation = UUID()
    private var playback = NativePlaybackLedger()
    private var observers: [NSObjectProtocol] = []
    private var muted = false
    private var suspended = false
    private var discardAudio = false
    private var microphoneQueue = NativeMicrophoneQueue()
    private var callRequest: URLRequest?
    private var callID = UUID()
    var sharedCameraCallID: String? { active && socketReady ? callID.uuidString : nil }
    private var socketReady = false
    private var resumeKnown = false
    private var transportSequence = 0
    private var pendingControls: [(id: String, item: [String: Any])] = []
    private var transportTimer: Timer?
    private var reconnectWork: DispatchWorkItem?
    private var reconnectSince: TimeInterval?
    private var reconnectAttempt = 0
    private var connectionOpenedAt: TimeInterval = 0
    private var pingAt: TimeInterval?
    private var lastPingAt: TimeInterval = 0
    private var monotonicNow: TimeInterval { ProcessInfo.processInfo.systemUptime }
    private var sequence = 0
    private var events: [[String: Any]] = []
    private var lastLevelAt = Date.distantPast
    private var receivedAudioBytes = 0
    private var microphoneBytes = 0
    private var backgroundMicrophoneBytes = 0
    private var lastDiagnosticBytes = 0
    private var playedTurns = 0
    private var backgroundedAt: String?
    private var lastPlayedInBackground = false
    private let pcm = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!

    func snapshot() -> [String: Any] {
        ["type": "native_snapshot", "active": active, "state": reconnectSince == nil ? state : "Reconnecting call…", "startedAt": startedAt,
         "muted": muted, "events": events, "reconnecting": reconnectSince != nil]
    }
    func acknowledge(_ seq: Int) { events.removeAll { ($0["seq"] as? Int ?? 0) <= seq } }
    private func emit(_ event: [String: Any], retain: Bool = true) {
        var item = event
        if retain {
            sequence += 1; item["seq"] = sequence
            // Collapse streaming text updates while the web view is suspended.
            if item["type"] as? String == "assistant", let last = events.last,
               last["type"] as? String == "assistant", last["turn"] as? Int == item["turn"] as? Int { events.removeLast() }
            if item["type"] as? String == "partial", events.last?["type"] as? String == "partial" { events.removeLast() }
            events.append(item)
            if events.count > 250 { events.removeFirst(events.count - 250) }
        }
        onEvent?(item)
    }
    func markBackground() { backgroundedAt = ISO8601DateFormatter().string(from: Date()); diagnostic("background") }
    func diagnostic(_ event: String) {
        let value: [String: Any] = ["event": event, "at": ISO8601DateFormatter().string(from: Date()),
            "active": active, "state": state, "muted": muted, "engineRunning": engine?.isRunning ?? false,
            "microphoneBytes": microphoneBytes, "backgroundMicrophoneBytes": backgroundMicrophoneBytes, "receivedAudioBytes": receivedAudioBytes, "playedTurns": playedTurns,
            "backgroundedAt": backgroundedAt ?? "", "lastPlayedInBackground": lastPlayedInBackground,
            "applicationState": UIApplication.shared.applicationState.rawValue,
            "route": AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue },
            "inputRoute": AVAudioSession.sharedInstance().currentRoute.inputs.map { $0.portType.rawValue },
            "sessionSampleRate": AVAudioSession.sharedInstance().sampleRate,
            "captureSampleRate": captureFormat?.sampleRate ?? 0,
            "audioErrors": audioErrors, "audioEvents": audioEvents, "probe": audioProbe,
            "systemCallRegistered": systemCall.callID != nil, "systemCallAudioActive": systemCall.audioActive,
            "systemInputMuted": audioApplication.isInputMuted, "muteNotifications": muteNotifications,
            "microphoneBytesWhileMuted": microphoneBytesWhileMuted,
            "queuedMicrophoneBytes": microphoneQueue.bytes.count,
            "droppedMicrophoneBytes": microphoneQueue.droppedBytes,
            "socketReady": socketReady, "reconnectAttempt": reconnectAttempt,
            "transportSequence": transportSequence, "pendingControls": pendingControls.count]
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: value, options: .prettyPrinted) else { return }
        try? data.write(to: dir.appendingPathComponent("NativeCall.json"), options: .atomic)
    }
    private func traceAudio(_ event: String, error: Error? = nil) {
        var item: [String: Any] = ["event": event, "at": ISO8601DateFormatter().string(from: Date()),
            "running": engine?.isRunning ?? false, "muted": muted, "attempt": recovery.attempt,
            "sampleRate": AVAudioSession.sharedInstance().sampleRate,
            "route": AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }]
        if let error {
            let e = error as NSError
            item["error"] = e.localizedDescription; item["domain"] = e.domain; item["code"] = e.code
            audioErrors.append(item); if audioErrors.count > 12 { audioErrors.removeFirst() }
        }
        audioEvents.append(item); if audioEvents.count > 40 { audioEvents.removeFirst() }
        diagnostic(event)
    }
    func start(home: URL, cookies: [HTTPCookie], mode: String = "classic", incomingID: String? = nil) {
        guard !active else { onEvent?(snapshot()); return }
        elevenMode = mode == "eleven"; incomingInvitationID = incomingID
        active = true; audioProbe = false; recovery.reset(); audioErrors = []; audioEvents = []; generation = UUID(); events = []; state = "connecting"
        startedAt = Date().timeIntervalSince1970 * 1000
        discardAudio = false
        callID = incomingID.flatMap(UUID.init(uuidString:)) ?? UUID(); resumeKnown = false; transportSequence = 0; pendingControls = []
        microphoneQueue = NativeMicrophoneQueue(); reconnectSince = nil; reconnectAttempt = 0
        backgroundMicrophoneBytes = 0; lastDiagnosticBytes = 0
        microphoneBytes = 0; receivedAudioBytes = 0; playedTurns = 0; backgroundedAt = nil
        let token = generation
        emit(["type": "native_open", "startedAt": startedAt])
        emit(["type": "state", "state": state])
        AVAudioApplication.requestRecordPermission { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == token else { return }
                guard allowed else { self.fail("Allow microphone access in Settings to talk with Samantha."); return }
                do {
                    self.installObservers()
                    try self.audioApplication.setInputMuted(false)
                    self.muted = false; self.muteNotifications = 0; self.microphoneBytesWhileMuted = 0
                    if !self.elevenMode { self.systemCall.start() }
                    var url = URLComponents(url: home.appendingPathComponent("live"), resolvingAgainstBaseURL: false)!
                    url.scheme = "wss"
                    if let incomingID { url.queryItems = [URLQueryItem(name: "callId", value: incomingID), URLQueryItem(name: "incoming", value: "1")] }
                    var request = URLRequest(url: url.url!)
                    request.setValue(String(home.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
                    for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: key) }
                    self.callRequest = request
                    let config = URLSessionConfiguration.ephemeral
                    config.timeoutIntervalForRequest = 15
                    config.timeoutIntervalForResource = 86400
                    self.session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
                    self.transportTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.checkTransport() }
                    self.connectTransport()
                } catch { self.fail("Could not start call audio: \(error.localizedDescription)") }
            }
        }
    }
    private func activateAudioSession() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audio.setPreferredIOBufferDuration(0.02)
        if systemCall.callID == nil { try audio.setActive(true) }
    }
    private var audioHealthy: Bool {
        guard let engine, engine.isRunning, tapInstalled, let captureFormat else { return false }
        let format = engine.inputNode.outputFormat(forBus: 0)
        return format.sampleRate == captureFormat.sampleRate && format.channelCount == captureFormat.channelCount
    }
    private func configureAudio() throws {
        let next: AVAudioEngine, output: AVAudioPlayerNode
        if let existing = engine, let existingPlayer = player {
            next = existing; output = existingPlayer
            next.stop(); output.stop()
            if tapInstalled { next.inputNode.removeTap(onBus: 0); tapInstalled = false }
        } else {
            next = AVAudioEngine(); output = AVAudioPlayerNode()
            engine = next; player = output
            next.attach(output); next.connect(output, to: next.mainMixerNode, format: pcm)
        }
        // Enable once per engine; keep the same I/O unit across Bluetooth sample-rate changes.
        if !next.inputNode.isVoiceProcessingEnabled { try next.inputNode.setVoiceProcessingEnabled(true) }
        let input = next.inputNode, inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: target) else {
            throw NSError(domain: "SAI", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone is available."])
        }
        let token = generation
        audioGeneration = UUID(); let captureToken = audioGeneration
        captureFormat = inputFormat
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / inputFormat.sampleRate)) + 32
            guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var consumed = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if consumed { status.pointee = .noDataNow; return nil }
                consumed = true; status.pointee = .haveData; return buffer
            }
            guard error == nil, converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
            let count = Int(converted.frameLength)
            let bytes = Data(bytes: samples, count: count * 2)
            var energy: Double = 0
            for i in 0..<count { let x = Double(samples[i]) / 32768; energy += x*x }
            let level = sqrt(energy / Double(count))
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == token, self.audioGeneration == captureToken,
                      !self.suspended else { return }
                // Keep fresh zero-valued microphone frames flowing while muted, including in the background.
                let data = self.muted ? Data(count: bytes.count) : bytes
                self.microphoneBytes += data.count
                if self.muted { self.microphoneBytesWhileMuted += data.count }
                if UIApplication.shared.applicationState != .active { self.backgroundMicrophoneBytes += data.count }
                if self.microphoneBytes - self.lastDiagnosticBytes > 320000 { self.lastDiagnosticBytes = self.microphoneBytes; self.diagnostic("audio_flow") }
                if self.audioProbe {
                    if !self.probeStarted { self.probeStarted = true; self.systemCall.markConnected(); self.scheduleProbeOutput() }
                    return
                }
                // Disconnected speech is not saved and replayed as a delayed user turn.
                if self.socketReady {
                    self.microphoneQueue.append(data)
                    self.flushMicrophone()
                }
                if Date().timeIntervalSince(self.lastLevelAt) > 0.12 {
                    self.lastLevelAt = Date()
                    if UIApplication.shared.applicationState == .active {
                        self.emit(["type": "native_level", "level": self.muted ? 0 : level, "speaker": "user"], retain: false)
                    }
                }
            }
        }
        tapInstalled = true
        next.prepare(); try next.start(); output.play()
        traceAudio("audio_started")
    }
    private func installObservers() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, self.active else { return }
            self.muted = note.userInfo?[AVAudioApplication.muteStateKey] as? Bool ?? self.audioApplication.isInputMuted
            self.muteNotifications += 1
            self.emit(["type": "native_mute", "muted": self.muted]); self.traceAudio("system_mute_notification")
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            DispatchQueue.main.async {
                guard let self, self.active, self.systemCall.callID == nil, let raw else { return }
                if AVAudioSession.InterruptionType(rawValue: raw) == .began {
                    self.suspended = true; self.recoveryWork?.cancel(); self.recovery.reset()
                    self.interrupt(); self.engine?.pause(); self.traceAudio("system_interruption")
                    self.emit(["type": "state", "state": "Call interrupted by iOS"])
                } else {
                    self.suspended = false
                    self.scheduleAudioRecovery()
                }
            }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] note in
            // Return to Apple's I/O notification thread before touching or releasing any engine.
            let changed = note.object as? AVAudioEngine
            DispatchQueue.main.async {
                guard let self, self.active, !self.suspended, let changed, changed === self.engine else { return }
                self.traceAudio("engine_configuration_changed")
                self.scheduleAudioRecovery()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.active, !self.suspended else { return }
                self.traceAudio("route_changed")
                self.scheduleAudioRecovery()
            }
        })
    }
    private func scheduleAudioRecovery() {
        guard active, !suspended, systemCall.callID == nil || systemCall.audioActive, let delay = recovery.request(healthy: audioHealthy) else { return }
        queueAudioRecovery(after: delay)
    }
    private func queueAudioRecovery(after delay: TimeInterval) {
        recoveryWork?.cancel()
        let token = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active, self.generation == token, !self.suspended else { return }
            self.recoveryWork = nil
            if self.audioHealthy { self.recovery.reset(); return }
            let first = self.recovery.begin()
            if first {
                self.interrupt()
                self.emit(["type": "state", "state": "Connecting audio"])
            }
            do {
                try self.activateAudioSession()
                try self.configureAudio()
                self.recovery.reset()
                self.emit(["type": "state", "state": self.state])
            } catch {
                self.traceAudio("audio_recovery_retry", error: error)
                if let delay = self.recovery.retryDelay() { self.queueAudioRecovery(after: delay) }
                else { self.fail("Call audio could not reconnect after the device changed. Please try again.") }
            }
        }
        recoveryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
    private func stopAudio() {
        recoveryWork?.cancel(); recoveryWork = nil; recovery.reset()
        audioGeneration = UUID()
        let old = engine; engine = nil
        if tapInstalled { old?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        old?.stop(); player?.stop(); player = nil; captureFormat = nil
    }
    func setMuted(_ value: Bool) {
        guard active else { return }
        if elevenMode { withEleven { $0.setMuted(value) }; return }
        if systemCall.callID != nil { systemCall.setMuted(value); return }
        do { try applyInputMute(value) }
        catch { emit(["type": "error", "error": "Could not change the microphone mute state."]) }
    }
    private func applyInputMute(_ value: Bool) throws {
        try audioApplication.setInputMuted(value)
        muted = audioApplication.isInputMuted
        emit(["type": "native_mute", "muted": muted]); traceAudio("mute_applied")
    }
    func requestEnd() {
        if systemCall.callID != nil { systemCall.requestEnd() } else { stop() }
    }
    func interrupt() {
        if elevenMode { withEleven { $0.interrupt() } }
        discardAudio = true
        playback.cancel(); player?.stop(); if engine?.isRunning == true { player?.play() }
        send(["type": "interrupt"])
    }
    private func connectTransport() {
        guard active, !audioProbe, let session, var request = callRequest else { return }
        reconnectWork?.cancel(); reconnectWork = nil
        var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "mode", value: elevenMode ? "eleven" : "classic"), URLQueryItem(name: "callId", value: callID.uuidString),
                          URLQueryItem(name: "after", value: String(transportSequence)),
                          URLQueryItem(name: "resume", value: resumeKnown ? "1" : "0")]
        if incomingInvitationID != nil { url.queryItems?.append(URLQueryItem(name: "incoming", value: "1")) }
        request.url = url.url
        socketReady = false; connectionOpenedAt = monotonicNow; pingAt = nil
        let ws = session.webSocketTask(with: request)
        socket = ws; ws.maximumMessageSize = 4 * 1024 * 1024; ws.resume()
        receive(ws, token: generation)
    }
    private func transportLost(_ reason: String, error: Error? = nil) {
        guard active, !audioProbe else { return }
        if socket == nil && reconnectWork != nil { return }
        let old = socket; socket = nil; socketReady = false; pingAt = nil
        old?.cancel(with: .goingAway, reason: nil)
        microphoneQueue.reset()
        reconnectSince = reconnectSince ?? monotonicNow
        if monotonicNow - reconnectSince! >= 75 {
            fail("The connection to Samantha could not recover. Please check your connection and start a new call."); return
        }
        reconnectAttempt += 1
        traceAudio(reason, error: error)
        emit(["type": "state", "state": "Reconnecting call…"])
        let token = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active, self.generation == token else { return }
            self.connectTransport()
        }
        reconnectWork?.cancel(); reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + min(4, 0.5 * pow(2, Double(min(reconnectAttempt - 1, 3)))), execute: work)
    }
    func networkAvailable() {
        guard active, reconnectSince != nil, socket == nil else { return }
        connectTransport()
    }
    private func checkTransport() {
        guard active, !audioProbe else { return }
        let now = monotonicNow
        if let since = reconnectSince, now - since >= 75 {
            fail("The connection to Samantha could not recover. Please check your connection and start a new call."); return
        }
        guard let ws = socket else { return }
        if !socketReady {
            if now - connectionOpenedAt >= 12 { transportLost("connection_open_timeout") }
            return
        }
        if microphoneQueue.stalled(now: now) { transportLost("microphone_send_stalled"); return }
        if let at = pingAt, now - at >= 8 { transportLost("connection_ping_timeout"); return }
        if pingAt == nil && now - lastPingAt >= 5 {
            pingAt = now; lastPingAt = now
            ws.sendPing { [weak self] error in
                DispatchQueue.main.async {
                    guard let self, self.active, self.socket === ws else { return }
                    self.pingAt = nil
                    if let error { self.transportLost("connection_ping_failed", error: error) }
                }
            }
        }
    }
    private func flushMicrophone() {
        guard active, socketReady, let ws = socket,
              let packet = microphoneQueue.next(now: monotonicNow) else { return }
        ws.send(.data(packet.data)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self, self.active, self.socket === ws,
                      self.microphoneQueue.completed(packet.id) else { return }
                if let error { self.transportLost("microphone_send_failed", error: error) }
                else { self.flushMicrophone() }
            }
        }
    }
    private func write(_ item: [String: Any]) {
        guard socketReady, let ws = socket,
              let data = try? JSONSerialization.data(withJSONObject: item),
              let value = String(data: data, encoding: .utf8) else { return }
        ws.send(.string(value)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self, self.active, self.socket === ws, let error else { return }
                self.transportLost("control_send_failed", error: error)
            }
        }
    }
    func send(_ item: [String: Any]) {
        guard active, !audioProbe else { return }
        var message = item
        let id = UUID().uuidString; message["controlId"] = id
        // Playback receipts and interrupts survive a socket replacement exactly once.
        pendingControls.append((id, message))
        guard pendingControls.count <= 64 else { fail("Call controls could not reach Samantha. Please reconnect."); return }
        write(message)
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === socket, active else { return }
        // Wait for the authenticated server's transport_ready before sending PCM.
        diagnostic("socket_opened")
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if webSocketTask === socket, active { transportLost("connection_closed") }
    }
    private func receive(_ ws: URLSessionWebSocketTask, token: UUID) {
        ws.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == token, self.socket === ws else { return }
                switch result {
                case .failure(let error): self.transportLost("connection_receive_failed", error: error)
                case .success(let frame):
                    let data: Data?
                    switch frame { case .string(let value): data = value.data(using: .utf8); case .data(let value): data = value; @unknown default: data = nil }
                    if let data, let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                        let type = message["type"] as? String
                        if type == "transport_ready" {
                            self.socketReady = true; self.resumeKnown = true
                            self.reconnectSince = nil; self.reconnectAttempt = 0
                            for control in self.pendingControls { self.write(control.item) }
                            self.send(["type": "hello", "capabilities": ["proactive-voice-v1", "native-background-v1", "resume-v1", "eleven-agent-v1"]])
                            self.emit(["type": "state", "state": self.state]); self.traceAudio("transport_ready")
                        } else if type == "control_ack", let id = message["controlId"] as? String {
                            self.pendingControls.removeAll { $0.id == id }
                        } else if let seq = message["transportSeq"] as? Int {
                            if seq == self.transportSequence + 1 {
                                self.transportSequence = seq; self.handle(message)
                            } else if seq > self.transportSequence + 1 {
                                self.transportLost("connection_event_gap"); return
                            }
                            self.write(["type": "transport_ack", "seq": self.transportSequence])
                        } else if type == "error" {
                            self.fail(message["error"] as? String ?? "The call could not resume."); return
                        }
                    }
                    if self.active, self.socket === ws { self.receive(ws, token: token) }
                }
            }
        }
    }
    private func handle(_ item: [String: Any]) {
        let type = item["type"] as? String ?? ""
        let turn = item["turn"] as? Int
        switch type {
        case "state":
            state = item["state"] as? String ?? state
            if state == "listening" { systemCall.markConnected() }
        case "user", "assistant_start": discardAudio = false; playback.cancel(); player?.stop(); player?.play()
        case "audio":
            guard !suspended, !discardAudio, let turn, let encoded = item["audio"] as? String, let bytes = Data(base64Encoded: encoded),
                  let player, let buffer = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: AVAudioFrameCount(bytes.count / 2)),
                  let samples = buffer.floatChannelData?[0] else { return }
            buffer.frameLength = buffer.frameCapacity
            var energy: Float = 0
            bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                for i in 0..<Int(buffer.frameLength) {
                    let value = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i*2, as: Int16.self))) / 32768
                    samples[i] = value; energy += value * value
                }
            }
            guard buffer.frameLength > 0, let ticket = playback.enqueue(turn: turn) else { return }
            receivedAudioBytes += bytes.count
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.playback.rendered(ticket: ticket)
                    self.finishPlaybackIfReady()
                }
            }
            if !player.isPlaying { player.play() }
            if UIApplication.shared.applicationState == .active {
                emit(["type": "native_level", "speaker": "assistant", "level": sqrt(energy / Float(buffer.frameLength))], retain: false)
            }
            return
        case "eleven_start": if elevenMode { withEleven { $0.start(item) } }; return
        case "context_update": if let text = item["text"] as? String { withEleven { $0.updateContext(text) } }; return
        case "tool_result": if let id = item["toolCallId"] as? String { let result = item["result"] as? String ?? "", isError = item["isError"] as? Bool ?? false; withEleven { $0.toolResult(id: id, result: result, isError: isError) } }; return
        case "eleven_interrupt": withEleven { $0.interrupt() }; return
        case "eleven_end": withEleven { $0.end() }; return
        case "audio_done": if let turn { playback.finish(turn: turn); finishPlaybackIfReady() }; return
        case "voice_error": if let turn { playback.fail(turn: turn); finishPlaybackIfReady() }
        case "interrupted": discardAudio = true; playback.cancel(); player?.stop(); player?.play()
        case "ended": stop(); return
        default: break
        }
        emit(item)
    }
    private func finishPlaybackIfReady() {
        guard let result = playback.takeCompletion() else { return }
        send(["type": result.success ? "playback_done" : "playback_failed", "turn": result.turn])
        if result.success { playedTurns += 1; lastPlayedInBackground = UIApplication.shared.applicationState != .active }
        emit(["type": "native_played", "turn": result.turn, "success": result.success])
        diagnostic(result.success ? "playback_complete" : "playback_failed")
    }
    private func fail(_ text: String) {
        traceAudio("call_failed", error: NSError(domain: "SAI", code: 2, userInfo: [NSLocalizedDescriptionKey: text]))
        emit(["type": "error", "error": text]); stop()
    }
    /// Explicit developer launch probe: no network, no model turn, no audio recording saved.
    func startAudioProbe(useCallKit: Bool = false) {
        guard !active else { return }
        active = true; audioProbe = true; probeStarted = false; generation = UUID()
        muteNotifications = 0; microphoneBytesWhileMuted = 0
        state = "testing audio"; startedAt = Date().timeIntervalSince1970 * 1000
        microphoneBytes = 0; backgroundMicrophoneBytes = 0; lastDiagnosticBytes = 0
        receivedAudioBytes = 0; playedTurns = 0; audioErrors = []; audioEvents = []; recovery.reset()
        let token = generation
        AVAudioApplication.requestRecordPermission { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == token else { return }
                guard allowed else { self.fail("Microphone permission is required for the audio check."); return }
                self.installObservers()
                do {
                    try self.audioApplication.setInputMuted(!useCallKit); self.muted = !useCallKit
                    if useCallKit { self.systemCall.start(label: "SAI audio check") }
                    else { try self.activateAudioSession(); try self.configureAudio() }
                } catch { self.traceAudio("probe_audio_pending", error: error); self.scheduleAudioRecovery() }
                if useCallKit {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                        guard let self, self.generation == token else { return }
                        self.setMuted(true)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                        guard let self, self.generation == token else { return }
                        self.setMuted(false)
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                    guard let self, self.generation == token else { return }
                    self.scheduleProbeOutput()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                    guard let self, self.generation == token else { return }
                    self.traceAudio("probe_complete"); self.stop()
                }
            }
        }
    }
    private func scheduleProbeOutput() {
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.active, self.generation == token, self.audioProbe, self.audioHealthy else { return }
            // Short quiet calibration tone confirms the real output callback; it is not Samantha speech.
            var values = [Int16](repeating: 0, count: 6000)
            for i in values.indices {
                let fade = min(1, Double(i)/240, Double(values.count-i)/240)
                values[i] = Int16(sin(Double(i) * 2 * .pi * 440 / 24000) * 650 * fade)
            }
            let data = values.withUnsafeBytes { Data($0) }
            self.handle(["type": "assistant_start", "turn": 987654])
            self.handle(["type": "audio", "turn": 987654, "sampleRate": 24000, "audio": data.base64EncodedString()])
            self.handle(["type": "audio_done", "turn": 987654])
        }
    }
    func stop() {
        guard active else { return }
        let systemOwned = systemCall.callID != nil || systemCall.audioActive
        systemCall.finish(); if elevenMode { withEleven { $0.end() } }
        write(["type": "end"])
        // End the logical call even when the audio socket is being replaced.
        if var request = callRequest, let url = request.url {
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            parts.scheme = "https"; parts.path = "/api/live/end"; parts.query = nil
            request.url = parts.url; request.httpMethod = "POST"; request.timeoutInterval = 8
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["callId": callID.uuidString])
            URLSession.shared.dataTask(with: request).resume()
        }
        active = false; generation = UUID(); state = "idle"; suspended = false
        transportTimer?.invalidate(); transportTimer = nil
        reconnectWork?.cancel(); reconnectWork = nil; reconnectSince = nil
        socketReady = false; microphoneQueue.reset(); pendingControls = []; callRequest = nil
        playback.cancel(); stopAudio()
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        session?.invalidateAndCancel(); session = nil
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        try? audioApplication.setInputMuted(false); muted = false
        if !systemOwned { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        elevenMode = false
        emit(["type": "ended"]); diagnostic("ended")
    }
}
