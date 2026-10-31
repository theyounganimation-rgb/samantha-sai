import UIKit
import UserNotifications

final class SAIAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = MessageNotifications.shared
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MessageNotifications.shared.registered(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MessageNotifications.shared.failed("Apple registration failed: \(error.localizedDescription)")
    }
}

/// Ordinary message alerts use APNs alert tokens, separate from PushKit calls.
final class MessageNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = MessageNotifications()
    private var home: URL?
    private var cookies: [HTTPCookie] = []
    private var token: String?
    private var permission = "unknown"
    private var asking = false
    private var registrationInFlight = false
    private var pendingRegistration = false
    private var enabled = false
    private let deviceID: String = {
        if let id = UserDefaults.standard.string(forKey: "notifications.deviceID") { return id }
        let id = UUID().uuidString; UserDefaults.standard.set(id, forKey: "notifications.deviceID"); return id
    }()
    var onOpen: (() -> Void)?
    func configure(home: URL, cookies: [HTTPCookie]) {
        self.home = home; self.cookies = cookies
        guard cookies.contains(where: { $0.name == "sai_session" }) else { return }
        refresh()
    }
    func refresh() {
        guard home != nil, !cookies.isEmpty else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.permission = String(describing: settings.authorizationStatus)
                if settings.authorizationStatus == .notDetermined {
                    guard !self.asking else { return }; self.asking = true
                    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                        DispatchQueue.main.async { self.asking = false; self.refresh() }
                    }
                    self.record("awaiting-permission"); return
                }
                self.enabled = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
                if self.enabled { UIApplication.shared.registerForRemoteNotifications() }
                self.registerWithServer()
            }
        }
    }
    func registered(_ data: Data) { token = data.map { String(format: "%02x", $0) }.joined(); registerWithServer() }
    func failed(_ error: String) { record("registration-failed", error: error) }
    private func registerWithServer() {
        guard let home, !cookies.isEmpty else { return }
        guard !enabled || token != nil else { record("waiting-for-apple-token"); return }
        guard !registrationInFlight else { pendingRegistration = true; return }
        registrationInFlight = true
        var request = URLRequest(url: home.appendingPathComponent("api/notifications/register"), timeoutInterval: 12)
        request.httpMethod = "POST"
        request.setValue(String(home.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: key) }
        // This locally signed app's aps-environment entitlement is development,
        // including Release builds. A distribution build must change both.
        var body: [String: Any] = ["deviceId": deviceID, "environment": "sandbox", "enabled": enabled]
        if let token { body["pushToken"] = token }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { _, response, error in
            DispatchQueue.main.async {
                self.registrationInFlight = false
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                self.record(status == 200 ? (self.enabled ? "registered" : "disabled") : "server-registration-failed", error: error?.localizedDescription ?? (status == 200 ? nil : "HTTP \(status)"))
                if self.pendingRegistration { self.pendingRegistration = false; self.registerWithServer() }
            }
        }.resume()
    }
    private func record(_ state: String, error: String? = nil) {
        var report: [String: Any] = ["state": state, "permission": permission, "hasToken": token != nil, "deviceId": deviceID, "at": ISO8601DateFormatter().string(from: Date())]
        if let error { report["error"] = error }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("NotificationStatus.json")
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The foreground conversation already shows the message via its live feed.
        completionHandler([])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { self.onOpen?(); completionHandler() }
    }
}
