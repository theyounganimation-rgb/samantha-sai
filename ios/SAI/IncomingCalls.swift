import AVFoundation
import CallKit
import Foundation
import PushKit
import UIKit

/// A real incoming-call invitation. Ringing never opens the microphone; answering connects the native voice session.
final class IncomingCalls: NSObject, PKPushRegistryDelegate, CXProviderDelegate, URLSessionDataDelegate {
    private let home: URL
    private let call: NativeVoiceCall
    private let deviceID: String
    private let provider: CXProvider
    private var registry: PKPushRegistry!
    private var cookies: [HTTPCookie] = []
    private var pushToken: String?
    private var session: URLSession?
    private var stream: URLSessionDataTask?
    private var buffer = Data()
    private var invitation: [String: Any]?
    private var answered = false
    private var waitingForAudio = false
    private var expiry: Timer?
    private var retry: DispatchWorkItem?
    private var online = false
    init(home: URL, call: NativeVoiceCall) {
        self.home = home; self.call = call
        if let saved = UserDefaults.standard.string(forKey: "incoming.deviceID") { deviceID = saved }
        else { let id = UUID().uuidString; deviceID = id; UserDefaults.standard.set(id, forKey: "incoming.deviceID") }
        let config = CXProviderConfiguration(); config.supportsVideo = false; config.maximumCallGroups = 1; config.maximumCallsPerCallGroup = 1; config.includesCallsInRecents = false; config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init(); provider.setDelegate(self, queue: .main)
        registry = PKPushRegistry(queue: .main); registry.delegate = self; registry.desiredPushTypes = [.voIP]
    }
    private func request(_ path: String, body: [String: Any]? = nil) -> URLRequest {
        let base = home.appendingPathComponent("api/call/incoming/")
        var req = URLRequest(url: URL(string: path, relativeTo: base)!.absoluteURL, timeoutInterval: 12)
        req.setValue(String(home.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
        for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { req.setValue(value, forHTTPHeaderField: key) }
        if let body { req.httpMethod = "POST"; req.httpBody = try? JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return req
    }
    private func post(_ path: String, _ body: [String: Any], done: ((Bool) -> Void)? = nil) {
        URLSession.shared.dataTask(with: request(path, body: body)) { _, response, error in
            let ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done?(ok) }
        }.resume()
    }
    func configure(cookies: [HTTPCookie]) {
        self.cookies = cookies; online = UIApplication.shared.applicationState == .active
        guard !cookies.isEmpty else { return }
        var body: [String: Any] = ["deviceId": deviceID, "environment": "sandbox"]
        if let pushToken { body["pushToken"] = pushToken }
        post("register", body) { [weak self] ok in if ok { self?.connect() } }
    }
    func foreground() { online = true; if !cookies.isEmpty { connect() } }
    func background() { online = false; retry?.cancel(); stream?.cancel(); stream = nil; session?.invalidateAndCancel(); session = nil }
    private func connect() {
        guard online, stream == nil else { return }
        buffer.removeAll(); let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 86400
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        stream = session?.dataTask(with: request("events?deviceId=" + deviceID)); stream?.resume()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        while let range = buffer.range(of: Data("\n\n".utf8)) {
            let chunk = buffer.subdata(in: buffer.startIndex..<range.lowerBound); buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            guard let text = String(data: chunk, encoding: .utf8), text.hasPrefix("data: "), let bytes = String(text.dropFirst(6)).data(using: .utf8), let payload = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { continue }
            ring(payload, completion: {})
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task == stream else { return }; stream = nil; session.invalidateAndCancel()
        guard online else { return }; let work = DispatchWorkItem { [weak self] in self?.connect() }; retry = work; DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        pushToken = pushCredentials.token.map { String(format: "%02x", $0) }.joined(); configure(cookies: cookies)
    }
    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) { pushToken = nil; if !cookies.isEmpty { post("register", ["deviceId": deviceID, "pushToken": NSNull(), "environment": "sandbox"]) } }
    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) { ring(payload.dictionaryPayload.reduce(into: [String: Any]()) { if let key = $1.key as? String { $0[key] = $1.value } }, completion: completion) }
    private func ring(_ payload: [String: Any], completion: @escaping () -> Void) {
        guard let raw = payload["callId"] as? String ?? payload["id"] as? String, let id = UUID(uuidString: raw) else { completion(); return }
        if invitation?["id"] as? String == raw { completion(); return }
        let update = CXCallUpdate(); update.localizedCallerName = "Samantha"; update.remoteHandle = CXHandle(type: .generic, value: "Samantha"); update.hasVideo = false; update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false; update.supportsDTMF = false
        provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
            DispatchQueue.main.async {
                defer { completion() }; guard let self, error == nil else { return }
                let until = (payload["expiresAt"] as? Double ?? 0) / 1000
                guard until > Date().timeIntervalSince1970, self.invitation == nil, !self.call.active else { self.provider.reportCall(with: id, endedAt: Date(), reason: .unanswered); return }
                self.invitation = ["id": raw, "expiresAt": until]; self.answered = false
                self.post("act", ["id": raw, "deviceId": self.deviceID, "action": "received"])
                self.expiry?.invalidate(); self.expiry = Timer.scheduledTimer(withTimeInterval: max(0.1, until - Date().timeIntervalSince1970), repeats: false) { [weak self] _ in self?.finish(reason: .unanswered) }
            }
        }
    }
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let raw = invitation?["id"] as? String, action.callUUID.uuidString.lowercased() == raw.lowercased() else { action.fail(); return }
        post("act", ["id": raw, "deviceId": deviceID, "action": "answer"]) { [weak self] ok in
            guard let self, ok else { action.fail(); self?.finish(reason: .failed); return }
            do { try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP]); self.expiry?.invalidate(); self.answered = true; self.waitingForAudio = true; action.fulfill() }
            catch { action.fail(); self.finish(reason: .failed) }
        }
    }
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        guard waitingForAudio, let id = invitation?["id"] as? String else { return }; waitingForAudio = false
        call.start(home: home, cookies: cookies, mode: "eleven", incomingID: id)
    }
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) { call.setMuted(action.isMuted); action.fulfill() }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let id = invitation?["id"] as? String { post("act", ["id": id, "deviceId": deviceID, "action": answered ? "end" : "decline"]) }
        if call.active { call.requestEnd() }; clear(); action.fulfill()
    }
    func providerDidReset(_ provider: CXProvider) { if call.active { call.requestEnd() }; clear() }
    func finish(reason: CXCallEndedReason = .remoteEnded) { if let raw = invitation?["id"] as? String, let id = UUID(uuidString: raw) { provider.reportCall(with: id, endedAt: Date(), reason: reason) }; clear() }
    private func clear() { expiry?.invalidate(); expiry = nil; invitation = nil; answered = false; waitingForAudio = false }
}
