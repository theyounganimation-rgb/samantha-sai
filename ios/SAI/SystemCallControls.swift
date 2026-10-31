import AVFoundation
import CallKit
import Foundation

/// Gives iOS ownership of headset gestures, system mute UI, tones, and call audio priority.
/// CallKit invokes all delegates on the main queue, matching NativeVoiceCall's state isolation.
final class SystemCallControls: NSObject, CXProviderDelegate {
    var configureAudio: (() throws -> Void)?
    var audioActivated: (() -> Void)?
    var audioDeactivated: (() -> Void)?
    var applyMute: ((Bool) throws -> Void)?
    var ended: (() -> Void)?
    var failed: ((Error) -> Void)?
    var trace: ((String) -> Void)?
    private let provider: CXProvider
    private let controller = CXCallController(queue: .main)
    private(set) var callID: UUID?
    private(set) var audioActive = false
    private var started = false
    private var ready = false
    private var connected = false
    private var label = "Samantha"

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
    }
    deinit { provider.invalidate() }
    func start(label: String = "Samantha") {
        guard callID == nil else { return }
        let id = UUID(); callID = id; self.label = label
        started = false; ready = false; connected = false; audioActive = false
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: label))
        action.isVideo = false
        request(action, id: id)
    }
    private func request(_ action: CXAction, id: UUID) {
        controller.request(CXTransaction(action: action)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self, self.callID == id else { return }
                if let error { self.trace?("callkit_transaction_failed"); self.failed?(error) }
            }
        }
    }
    func setMuted(_ muted: Bool) {
        guard let id = callID else { return }
        request(CXSetMutedCallAction(call: id, muted: muted), id: id)
    }
    func requestEnd() {
        guard let id = callID else { ended?(); return }
        request(CXEndCallAction(call: id), id: id)
    }
    func markConnected() {
        ready = true
        guard let id = callID, started, !connected else { return }
        connected = true; provider.reportOutgoingCall(with: id, connectedAt: Date())
        trace?("callkit_connected")
    }
    func finish() {
        guard let id = callID else { return }
        clear()
        provider.reportCall(with: id, endedAt: Date(), reason: .remoteEnded)
    }
    private func clear() {
        callID = nil; audioActive = false; started = false; ready = false; connected = false
    }
    func providerDidReset(_ provider: CXProvider) { clear(); trace?("callkit_reset"); ended?() }
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard action.callUUID == callID else { action.fail(); return }
        do {
            // Configure only. The engine starts after CallKit activates the audio session.
            try configureAudio?()
            let update = CXCallUpdate()
            update.localizedCallerName = label
            update.remoteHandle = action.handle
            update.supportsDTMF = false; update.supportsHolding = false
            update.supportsGrouping = false; update.supportsUngrouping = false; update.hasVideo = false
            provider.reportCall(with: action.callUUID, updated: update)
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
            started = true; action.fulfill()
            trace?("callkit_started")
            if ready { markConnected() }
        } catch { action.fail(); failed?(error) }
    }
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        guard callID != nil else { return }
        audioActive = true; trace?("callkit_audio_activated"); audioActivated?()
    }
    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        audioActive = false
        if callID != nil { trace?("callkit_audio_deactivated"); audioDeactivated?() }
    }
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard action.callUUID == callID else { action.fail(); return }
        do {
            try applyMute?(action.isMuted)
            trace?(action.isMuted ? "callkit_muted" : "callkit_unmuted")
            action.fulfill()
        } catch { action.fail(); failed?(error) }
    }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard action.callUUID == callID else { action.fail(); return }
        clear(); trace?("callkit_ended"); ended?(); action.fulfill()
    }
    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        guard let action = action as? CXCallAction, action.callUUID == callID else { return }
        failed?(NSError(domain: "SAICallKit", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The system call control timed out."]))
    }
}
