import Foundation
import AVFoundation
import WatchKit

/// Watch audio owns its microphone and playback. The Mac remains the single call authority.
/// A broken socket resumes the same call; microphone audio is never replayed.
final class WatchVoiceCall: NSObject, ObservableObject {
    @Published var active = false
    @Published var state = ""
    @Published var error: String?
    @Published var muted = false
    @Published var level: Float = 0
    @Published var userLevel: Float = 0
    private(set) var networkProbe = false
    private var probeStarted: TimeInterval = 0
    private var probeDisconnected = false
    private var audioRenewing = false
    private var lastAudioActivation: TimeInterval = 0
    private var lastAudioRenewAttempt: TimeInterval = 0
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var player: AVAudioPlayerNode?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var playback = NativePlaybackLedger()
    private var ready = false
    private var discard = false
    private var sequence = 0
    private var generation = UUID()
    private var callID = UUID()
    private var home: URL?
    private var cookie = ""
    private var timeout: Timer?
    private var ping: Timer?
    private var observer: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?
    private var microphone = NativeMicrophoneQueue()
    private var pendingControls: [(id: String, item: [String: Any])] = []
    private var resumeKnown = false
    private var reconnectSince: TimeInterval?
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var openedAt: TimeInterval = 0
    private var pingAt: TimeInterval?
    private var lastPingAt: TimeInterval = 0
    private var lastCallState = "Connecting"
    private var diagnostics: [[String: Any]] = []
    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    private var lastLevel = Date.distantPast
    private let pcm = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!

    func start(home: URL, cookie: String, networkProbe: Bool = false) {
        guard !active, !cookie.isEmpty else { return }
        self.home = home; self.cookie = cookie; active = true; error = nil; state = "Connecting"; muted = false
        self.networkProbe = networkProbe; muted = networkProbe; probeStarted = now; probeDisconnected = false
        audioRenewing = false; lastAudioActivation = now; lastAudioRenewAttempt = now
        generation = UUID(); callID = UUID(); sequence = 0; ready = false; discard = false
        microphone.reset(); pendingControls.removeAll(); resumeKnown = false
        reconnectSince = nil; reconnectAttempt = 0; lastCallState = "Connecting"
        diagnostic("start")
        let token = generation
        timeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in self?.fail("Couldn’t connect. Keep your iPhone nearby with Tailscale connected, then try again.") }
        AVAudioApplication.requestRecordPermission { [weak self] allowed in
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == token else { return }
                guard allowed else { self.fail("Allow SAI microphone access in Watch Settings."); return }
                do {
                    let audio = AVAudioSession.sharedInstance()
                    try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [])
                    audio.activate(options: []) { success, error in
                        DispatchQueue.main.async {
                            guard self.active, self.generation == token else { return }
                            guard success else { self.fail(error?.localizedDescription ?? "Watch audio could not start."); return }
                            self.lastAudioActivation = self.now; self.diagnostic("audio_activated")
                            do {
                                try self.configureAudio(); self.connect(token)
                                self.ping = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.checkTransport() }
                            }
                            catch { self.fail(error.localizedDescription) }
                        }
                    }
                } catch { self.fail(error.localizedDescription) }
            }
        }
    }
    private func configureAudio() throws {
        let next = AVAudioEngine(), output = AVAudioPlayerNode()
        engine = next; player = output; next.attach(output); next.connect(output, to: next.mainMixerNode, format: pcm)
        try next.inputNode.setVoiceProcessingEnabled(true)
        let input = next.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target) else { throw URLError(.cannotDecodeRawData) }
        let token = generation
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / format.sampleRate) + 8)) else { return }
            var supplied = false; var error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true; state.pointee = .haveData; return buffer
            }
            guard status != .error, error == nil, let bytes = converted.int16ChannelData?[0] else { return }
            let data = Data(bytes: bytes, count: Int(converted.frameLength) * 2)
            var sum: Float = 0
            for i in 0..<Int(converted.frameLength) { let v = Float(bytes[i])/32768; sum += v*v }
            let rms = sqrt(sum/Float(max(1,converted.frameLength)))
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == token, self.ready, !self.muted else { return }
                self.userLevel = self.state == "listening" ? min(1,rms*5) : 0
                self.microphone.append(data); self.flushMicrophone()
            }
        }
        tapInstalled = true
        next.prepare(); try next.start(); output.play()
        observer = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            if (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue { self?.fail("Call interrupted on your Watch. Tap Call to reconnect.") }
        }
        routeObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: next, queue: .main) { [weak self] _ in
            guard let self, self.active else { return }; self.fail("Audio device changed. Tap Call to reconnect.")
        }
    }
    private func connect(_ token: UUID) {
        guard active, generation == token, let home else { return }
        reconnectWork?.cancel(); reconnectWork = nil
        var url = URLComponents(url: home.appendingPathComponent("live"), resolvingAgainstBaseURL: false)!
        url.scheme = "wss"; url.queryItems = [URLQueryItem(name: "callId", value: callID.uuidString), URLQueryItem(name: "mode", value: "classic"), URLQueryItem(name: "after", value: String(sequence)), URLQueryItem(name: "resume", value: resumeKnown ? "1" : "0")]
        var request = URLRequest(url: url.url!, timeoutInterval: 20)
        request.setValue(cookie, forHTTPHeaderField: "Cookie"); request.setValue(String(home.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
        if session == nil {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 86400
            session = URLSession(configuration: config)
        }
        ready = false; openedAt = now; pingAt = nil
        let ws = session!.webSocketTask(with: request); socket = ws; ws.maximumMessageSize = 4 * 1024 * 1024; ws.resume(); receive(ws, token)
    }
    private func transportLost(_ reason: String, error: Error? = nil) {
        guard active, socket != nil || reconnectWork == nil else { return }
        diagnostic(reason, error: error)
        let old = socket; socket = nil; ready = false; pingAt = nil
        // Going away detaches the socket; normalClosure would end the Mac's call.
        old?.cancel(with: .goingAway, reason: nil)
        microphone.reset(); userLevel = 0
        timeout?.invalidate(); timeout = nil
        reconnectSince = reconnectSince ?? now
        guard now - reconnectSince! < 75 else { fail("The call connection couldn’t recover. Check your connection and tap Call to reconnect."); return }
        state = "Reconnecting"; reconnectAttempt += 1
        let token = generation
        let work = DispatchWorkItem { [weak self] in self?.connect(token) }
        reconnectWork?.cancel(); reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + min(4, 0.5 * pow(2, Double(min(reconnectAttempt - 1, 3)))), execute: work)
    }
    func networkAvailable() {
        if active, reconnectSince != nil, socket == nil { connect(generation) }
    }
    private func checkTransport() {
        guard active else { return }
        // watchOS 26.x can revoke the audio networking grant ~35s after activate.
        // Renew only during this real active audio session, without stopping audio.
        // See Apple developer forum 841590 / FB24377808. Remove when fixed upstream.
        if !audioRenewing, now - lastAudioActivation >= 25, now - lastAudioRenewAttempt >= 5 {
            audioRenewing = true; lastAudioRenewAttempt = now
            let token = generation
            AVAudioSession.sharedInstance().activate(options: []) { [weak self] success, error in DispatchQueue.main.async {
                guard let self, self.active, self.generation == token else { return }
                self.audioRenewing = false
                if success { self.lastAudioActivation = self.now; self.diagnostic("audio_session_renewed") }
                else { self.diagnostic("audio_session_renew_failed", error: error) }
            } }
        }
        #if DEBUG
        if networkProbe {
            if now - probeStarted >= 100 { diagnostic("probe_complete"); end(); return }
            if now - probeStarted >= 60, !probeDisconnected, ready {
                probeDisconnected = true; transportLost("probe_forced_disconnect"); return
            }
        }
        #endif
        if let since = reconnectSince, now - since >= 75 { fail("The call connection couldn’t recover. Check your connection and tap Call to reconnect."); return }
        guard let ws = socket else { return }
        if !ready { if now - openedAt >= 12 { transportLost("open_timeout") }; return }
        if microphone.stalled(now: now) { transportLost("microphone_stalled"); return }
        if let sent = pingAt, now - sent >= 8 { transportLost("ping_timeout"); return }
        if pingAt == nil, now - lastPingAt >= 5 {
            pingAt = now; lastPingAt = now
            ws.sendPing { [weak self] error in DispatchQueue.main.async {
                guard let self, self.active, self.socket === ws else { return }
                self.pingAt = nil
                if let error { self.transportLost("ping_failed", error: error) }
            } }
        }
    }
    private func flushMicrophone() {
        guard active, ready, let ws = socket, let packet = microphone.next(now: now) else { return }
        ws.send(.data(packet.data)) { [weak self] error in DispatchQueue.main.async {
            guard let self, self.active, self.socket === ws, self.microphone.completed(packet.id) else { return }
            if let error { self.transportLost("microphone_send_failed", error: error) }
            else { self.flushMicrophone() }
        } }
    }
    private func receive(_ ws: URLSessionWebSocketTask, _ token: UUID) {
        ws.receive { [weak self] result in DispatchQueue.main.async {
            guard let self, self.active, self.generation == token, self.socket === ws else { return }
            switch result {
            case .failure(let error): self.transportLost("receive_failed", error: error)
            case .success(let frame):
                let data: Data?
                switch frame { case .string(let s): data = s.data(using: .utf8); case .data(let d): data = d; @unknown default: data = nil }
                if let data, let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if item["type"] as? String == "transport_ready" {
                        self.ready = true
                        self.resumeKnown = true; self.reconnectSince = nil; self.reconnectAttempt = 0
                        self.state = self.lastCallState
                        self.diagnostic("transport_ready")
                        for control in self.pendingControls { self.write(control.item) }
                        self.send(["type": "hello", "capabilities": self.networkProbe ? ["resume-v1"] : ["proactive-voice-v1", "native-background-v1", "resume-v1"]])
                    } else if item["type"] as? String == "control_ack", let id = item["controlId"] as? String {
                        self.pendingControls.removeAll { $0.id == id }
                    } else if let seq = item["transportSeq"] as? Int {
                        if seq == self.sequence + 1 { self.sequence = seq; self.handle(item) }
                        else if seq > self.sequence + 1 { self.transportLost("event_gap"); return }
                        self.send(["type": "transport_ack", "seq": self.sequence], tracked: false)
                    } else if item["type"] as? String == "error" { self.fail(item["error"] as? String ?? "Call unavailable.") }
                }
                if self.active, self.socket === ws { self.receive(ws, token) }
            }
        } }
    }
    private func handle(_ item: [String: Any]) {
        let turn = item["turn"] as? Int
        switch item["type"] as? String {
        case "state":
            state = item["state"] as? String ?? state
            lastCallState = state
            if state == "listening" { timeout?.invalidate(); timeout = nil }
        case "user", "assistant_start": discard = false; playback.cancel(); player?.stop(); player?.play()
        case "audio":
            guard !discard, let turn, let encoded = item["audio"] as? String, let data = Data(base64Encoded: encoded), data.count > 0, data.count % 2 == 0,
                  let output = player, let buffer = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: AVAudioFrameCount(data.count / 2)), let samples = buffer.floatChannelData?[0], let ticket = playback.enqueue(turn: turn) else { return }
            buffer.frameLength = buffer.frameCapacity
            var energy: Float = 0
            data.withUnsafeBytes { raw in for i in 0..<Int(buffer.frameLength) {
                let sample = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768
                samples[i] = sample; energy += sample * sample
            } }
            level = min(1, sqrt(energy / Float(buffer.frameLength)) * 5); lastLevel = Date()
            output.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in DispatchQueue.main.async {
                guard let self else { return }; self.playback.rendered(ticket: ticket); self.complete()
                if Date().timeIntervalSince(self.lastLevel) > 0.2 { self.level *= 0.4 }
            } }
            if !output.isPlaying { output.play() }
        case "audio_done": if let turn { playback.finish(turn: turn); complete() }
        case "voice_error": if let turn { playback.fail(turn: turn); complete() }; error = item["error"] as? String ?? "Samantha’s voice was interrupted."
        case "interrupted": discard = true; playback.cancel(); player?.stop(); player?.play(); level = 0
        case "ended": end(notify: false)
        case "error": fail(item["error"] as? String ?? "Call unavailable.")
        default: break
        }
    }
    private func complete() {
        guard let done = playback.takeCompletion() else { return }
        send(["type": done.success ? "playback_done" : "playback_failed", "turn": done.turn]); level = 0
    }
    private func send(_ value: [String: Any], tracked: Bool = true) {
        var item = value
        if tracked {
            let id = UUID().uuidString; item["controlId"] = id
            pendingControls.append((id, item))
            guard pendingControls.count <= 64 else { fail("Call controls couldn’t reach Samantha. Tap Call to reconnect."); return }
        }
        write(item)
    }
    private func write(_ item: [String: Any]) {
        guard ready, let ws = socket else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: item), let text = String(data: data, encoding: .utf8) else { return }
        ws.send(.string(text)) { [weak self] error in DispatchQueue.main.async {
            guard let self, self.active, self.socket === ws, let error else { return }
            self.transportLost("control_send_failed", error: error)
        } }
    }
    private func diagnostic(_ event: String, error: Error? = nil) {
        var row: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()), "event": event, "callId": callID.uuidString, "sequence": sequence]
        if let e = error as NSError? { row["errorDomain"] = e.domain; row["errorCode"] = e.code }
        if let socket { row["closeCode"] = socket.closeCode.rawValue }
        diagnostics.append(row); if diagnostics.count > 80 { diagnostics.removeFirst(diagnostics.count - 80) }
        if let data = try? JSONSerialization.data(withJSONObject: diagnostics), let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? data.write(to: dir.appendingPathComponent("voice-diagnostics.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
    func toggleMute() { guard !networkProbe else { return }; muted.toggle(); if muted { userLevel = 0; microphone.reset() } }
    func interrupt() { discard = true; playback.cancel(); player?.stop(); player?.play(); level = 0; send(["type": "interrupt"]) }
    private func fail(_ message: String) { guard active else { return }; diagnostic("failed"); end(); error = message }
    func end(notify: Bool = true) {
        guard active else { return }
        active = false
        if notify {
            send(["type": "end"])
            if let home {
                var request = URLRequest(url: home.appendingPathComponent("api/live/end"), timeoutInterval: 8)
                request.httpMethod = "POST"; request.setValue(cookie, forHTTPHeaderField: "Cookie")
                request.setValue(String(home.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: ["callId": callID.uuidString])
                URLSession.shared.dataTask(with: request).resume()
            }
        }
        diagnostic("end")
        generation = UUID(); timeout?.invalidate(); ping?.invalidate(); timeout = nil; ping = nil
        reconnectWork?.cancel(); reconnectWork = nil; reconnectSince = nil; microphone.reset(); pendingControls.removeAll()
        if let observer { NotificationCenter.default.removeObserver(observer) }; observer = nil
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }; routeObserver = nil
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }; engine?.stop(); player?.stop(); engine = nil; player = nil
        playback.cancel(); socket?.cancel(with: .normalClosure, reason: nil); socket = nil; session?.invalidateAndCancel(); session = nil
        ready = false; level = 0; userLevel = 0; state = ""; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
