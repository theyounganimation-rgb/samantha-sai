import Foundation
import WatchConnectivity
import Security

@MainActor final class WatchStore: NSObject, ObservableObject, WCSessionDelegate {
    @Published var messages: [WatchMessage] = []
    @Published var updatedAt: Date?
    @Published var notice = "Open SAI on your iPhone to connect."
    @Published var paired = false
    @Published var mood: [String: Any] = [:]
    let home = URL(string: "https://sai.example.invalid:18507/")!
    private(set) var cookie = ""
    private var refreshing = false
    private let service = "dev.example.sai.watch.device"
    private var cache: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("messages.json") }
    override init() {
        super.init()
        var query = keyQuery; query[kSecReturnData as String] = true
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data { cookie = String(data: data, encoding: .utf8) ?? "" }
        paired = !cookie.isEmpty
        if let data = try? Data(contentsOf: cache), let rows = try? JSONDecoder().decode([WatchMessage].self, from: data) { messages = rows }
        if let attributes = try? FileManager.default.attributesOfItem(atPath: cache.path) { updatedAt = attributes[.modificationDate] as? Date }
        if paired { notice = "Saved messages" }
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }
    private var keyQuery: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "paired-iphone"] }
    private func apply(_ context: [String: Any]) {
        guard context["version"] as? Int == 1 else { return }
        if context["paired"] as? Bool == false {
            cookie = ""; paired = false; messages = []; updatedAt = nil
            SecItemDelete(keyQuery as CFDictionary); try? FileManager.default.removeItem(at: cache)
            notice = "Reconnect SAI on your iPhone."; return
        }
        guard context["home"] as? String == home.absoluteString, let value = context["cookie"] as? String, !value.isEmpty else { return }
        cookie = value; paired = true
        SecItemDelete(keyQuery as CFDictionary)
        var query = keyQuery; query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
        if (context["updatedAt"] as? Double ?? 0) >= (updatedAt?.timeIntervalSince1970 ?? 0), let data = context["messages"] as? Data, let rows = try? JSONDecoder().decode([WatchMessage].self, from: data) {
            messages = rows; updatedAt = Date(timeIntervalSince1970: context["updatedAt"] as? Double ?? 0)
            try? data.write(to: cache, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        notice = context["syncError"] as? String ?? ""
    }
    func refresh() async {
        if WCSession.default.activationState == .activated && WCSession.default.isReachable {
            WCSession.default.sendMessage(["action": "refresh"], replyHandler: { context in DispatchQueue.main.async { self.apply(context) } }, errorHandler: { _ in })
        }
        guard !refreshing, paired else { return }
        refreshing = true; defer { refreshing = false }
        do {
            let data = try await get("api/history")
            messages = WatchSnapshot.messages(data, maxEncodedBytes: 2_000_000); updatedAt = Date(); notice = ""
            if let encoded = try? JSONEncoder().encode(messages) { try? encoded.write(to: cache, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
            await refreshMood()
        } catch { notice = "Showing saved messages. Open SAI on your iPhone to sync." }
    }
    func fullText(for message: WatchMessage) async -> String? {
        guard message.needsFullText == true else { return message.text }
        guard let data = try? await get("api/history"),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = object["messages"] as? [[String: Any]],
              let row = rows.first(where: { $0["id"] as? String == message.id }) else { return nil }
        return row["text"] as? String
    }
    func refreshMood() async {
        if let data = try? await get("api/call/mood"), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { mood = object }
    }
    private func get(_ path: String) async throws -> Data {
        var request = URLRequest(url: home.appendingPathComponent(path), timeoutInterval: 12)
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
        return data
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async { self.apply(WCSession.default.receivedApplicationContext); Task { @MainActor in await self.refresh() } }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) { DispatchQueue.main.async { self.apply(applicationContext) } }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { DispatchQueue.main.async { self.apply(message) } }
}
