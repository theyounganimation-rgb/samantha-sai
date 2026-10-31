import Foundation
import WatchConnectivity
import WebKit

/// Only the paired Watch receives SAI's device cookie. Provider keys never leave the Mac.
final class WatchCompanion: NSObject, WCSessionDelegate {
    private let home: URL
    private let cookieStore: WKHTTPCookieStore
    private var reading = false
    private var snapshot: [String: Any] = [:]
    init(home: URL, cookieStore: WKHTTPCookieStore) {
        self.home = home; self.cookieStore = cookieStore
        super.init()
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }
    func refresh() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated,
              WCSession.default.isPaired, WCSession.default.isWatchAppInstalled, !reading else { return }
        reading = true
        cookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            let matching = cookies.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == self.home.host && ($0.expiresDate ?? .distantFuture) > Date() }
            let cookie = HTTPCookie.requestHeaderFields(with: matching)["Cookie"] ?? ""
            guard !cookie.isEmpty else { self.publish(["version": 1, "paired": false]); self.reading = false; return }
            let context: [String: Any] = ["version": 1, "paired": true, "home": self.home.absoluteString, "cookie": cookie]
            var request = URLRequest(url: self.home.appendingPathComponent("api/history"), timeoutInterval: 20)
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
            URLSession.shared.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    self.reading = false
                    guard error == nil, let response = response as? HTTPURLResponse else { self.publish(context.merging(["syncError": "Mac unavailable. Showing saved messages."]) { _, b in b }); return }
                    if response.statusCode == 401 || response.statusCode == 403 { self.publish(["version": 1, "paired": false]); return }
                    guard response.statusCode == 200, let data,
                          let rows = try? JSONEncoder().encode(WatchSnapshot.messages(data)) else { self.publish(context); return }
                    self.publish(context.merging(["messages": rows, "updatedAt": Date().timeIntervalSince1970]) { _, b in b })
                }
            }.resume()
        }
    }
    private func publish(_ context: [String: Any]) {
        snapshot = context
        try? WCSession.default.updateApplicationContext(context)
        if WCSession.default.isReachable { WCSession.default.sendMessage(context, replyHandler: nil, errorHandler: { _ in }) }
    }
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) { DispatchQueue.main.async { self.refresh() } }
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    func sessionWatchStateDidChange(_ session: WCSession) { DispatchQueue.main.async { self.refresh() } }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async {
            guard message["action"] as? String == "refresh" else { replyHandler(["error": "Unsupported Watch request"]); return }
            replyHandler(self.snapshot.isEmpty ? ["pending": true] : self.snapshot)
            self.refresh()
        }
    }
}
