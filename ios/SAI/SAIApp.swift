import SwiftUI
import WebKit
import Network
import AVFoundation

private let home = URL(string: "https://sai.example.invalid:18507/")!
// Dark mode (Owner, October 25, 2026): the page follows the system appearance; these native surfaces match its two papers.
private let creamUI = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.090, green: 0.075, blue: 0.059, alpha: 1) : UIColor(red: 0.961, green: 0.945, blue: 0.922, alpha: 1) }
private let cream = Color(uiColor: creamUI)
private let coral = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.878, green: 0.404, blue: 0.290, alpha: 1) : UIColor(red: 0.83, green: 0.34, blue: 0.23, alpha: 1) })

@main
struct SAIApp: App {
    @UIApplicationDelegateAdaptor(SAIAppDelegate.self) private var appDelegate
    @StateObject private var connection = Connection()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            ZStack {
                cream.ignoresSafeArea()
                // The page moves its composer, while the web view and header stay full height.
                SamanthaWeb(connection: connection).ignoresSafeArea()
                if connection.cameraVisible {
                    VStack { HStack { Spacer()
                        // October 25 (Owner): the clip comes last so the label and buttons stay inside the rounded window; a switch-camera button for selfie mode.
                        PhoneCameraPreview(session: connection.vision.capture)
                            .frame(width:112,height:148)
                            .overlay(alignment:.topTrailing) { Button { connection.vision.stop() } label: { Image(systemName:"xmark.circle.fill").font(.title2).foregroundStyle(.white,.black.opacity(0.5)) }.padding(6).accessibilityLabel("Stop sharing camera") }
                            .overlay(alignment:.topLeading) { Button { connection.vision.flip() } label: { Image(systemName:"arrow.triangle.2.circlepath.camera.fill").font(.title3).foregroundStyle(.white,.black.opacity(0.5)) }.padding(7).accessibilityLabel("Switch camera") }
                            .overlay(alignment:.bottom) { Text("Your view").font(.caption).padding(5).foregroundStyle(.white).frame(maxWidth:.infinity).background(.black.opacity(0.45)) }
                            .clipShape(RoundedRectangle(cornerRadius:16))
                    }.padding(.trailing,18).padding(.top,68); Spacer() }
                }
                if connection.loading || connection.failure != nil || connection.needsPairing {
                    ConnectionView(connection: connection)
                }
            }
            .onOpenURL { connection.open($0) }
            .onChange(of: phase) { _, next in
                if next == .active { connection.foreground() }
                if next == .background { connection.background() }
            }
        }
    }
}

struct ConnectionView: View {
    @ObservedObject var connection: Connection
    @State private var pairingLink = ""
    var body: some View {
        if connection.loading && connection.failure == nil && !connection.needsPairing {
            // Use the same icon-derived artwork as the system launch screen.
            Image("LaunchMark").resizable().interpolation(.high).frame(width: 108, height: 108)
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(cream).ignoresSafeArea()
                .accessibilityLabel("SAI is connecting")
        } else {
        VStack(spacing: 22) {
            Spacer()
            Image("AppMark").resizable().frame(width: 112, height: 112).clipShape(RoundedRectangle(cornerRadius: 28))
            Text("SAI.").font(.system(size: 54, weight: .regular, design: .serif)).foregroundStyle(coral)
            Text(connection.needsPairing ? "Bring Samantha with you." : connection.failure == nil ? "A little closer." : "Let’s reconnect.")
                .font(.system(size: 27, design: .serif))
            if connection.loading && connection.failure == nil && !connection.needsPairing {
                ProgressView().tint(coral)
                Text("Connecting to Samantha").foregroundStyle(.secondary)
            } else if connection.needsPairing {
                Text("Create a device link in SAI’s settings on your Mac, then paste it here.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
                if let problem = connection.failure { Text(problem).font(.footnote).foregroundStyle(coral) }
                TextField("Paste your pairing link", text: $pairingLink).textInputAutocapitalization(.never)
                    .autocorrectionDisabled().keyboardType(.URL).textFieldStyle(.roundedBorder)
                Button("Connect") { connection.pair(pairingLink) }.buttonStyle(.borderedProminent).tint(coral)
            } else {
                Text(connection.failure ?? "").multilineTextAlignment(.center).foregroundStyle(.secondary)
                Button("Try again") { connection.reload() }.buttonStyle(.borderedProminent).tint(coral)
                Text("Keep Tailscale connected and your Mac awake. Wi-Fi or cellular both work.")
                    .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
            Spacer()
            Text("One Samantha. Every conversation.").font(.footnote).foregroundStyle(.secondary).padding(.bottom, 30)
        }.padding(32).frame(maxWidth: 500).frame(maxWidth: .infinity, maxHeight: .infinity).background(cream)
        }
    }
}

struct SamanthaWeb: UIViewRepresentable {
    @ObservedObject var connection: Connection
    func makeUIView(context: Context) -> WKWebView { connection.web }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

final class Connection: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    @Published var loading = true
    @Published var failure: String?
    @Published var needsPairing = false
    let web: WKWebView
    private var keyboard: NativeKeyboardLayout!
    private let monitor = NWPathMonitor()
    private var network = "checking"
    private var expensive = false
    private var ready = false
    private var timer: Timer?
    private var pendingPair: String?
    private let call = NativeVoiceCall()
    private var incoming: IncomingCalls!
    private var watch: WatchCompanion!
    let vision = PhoneVision()
    @Published var cameraVisible = false
    private var callRequest = UUID()

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        web = SamanthaWKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.addUserScript(WKUserScript(source: "window.saiNativeCalls = true; window.saiPhoneCamera = true; window.saiNativeKeyboard = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        incoming = IncomingCalls(home: home, call: call)
        watch = WatchCompanion(home: home, cookieStore: config.websiteDataStore.httpCookieStore)
        MessageNotifications.shared.onOpen = { [weak self] in self?.foreground() }
        config.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in DispatchQueue.main.async { self?.incoming.configure(cookies: cookies.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == home.host }) } }
        call.onEvent = { [weak self] event in
            guard let self else { return }
            if event["type"] as? String == "ended" { self.incoming.finish() }
            if event["type"] as? String == "ended" || (event["type"] as? String == "native_snapshot" && event["active"] as? Bool == false) { self.vision.stop(sendControl:false) }
            if event["type"] as? String == "outing", event["active"] as? Bool == false { self.vision.stop(sendControl:false) }
            self.deliverCallEvent(event)
        }
        vision.onStatus = { [weak self] event in
            self?.cameraVisible = event["enabled"] as? Bool == true && event["cameraStatus"] as? String != "paused"
            self?.deliverCallEvent(event)
        }
        config.userContentController.add(self, name: "sai")
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = creamUI
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        keyboard = NativeKeyboardLayout(web: web)
        #if DEBUG
        web.isInspectable = true
        if ProcessInfo.processInfo.arguments.contains("--sai-keyboard-layout-probe") {
            KeyboardLayoutProbe.install(on: web)
        }
        #if targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--sai-keyboard-fixture") {
            KeyboardLayoutProbe.installFixture(on: web)
        }
        #endif
        #endif
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                self.network = path.status != .satisfied ? "offline" : path.usesInterfaceType(.cellular) ? "cellular" : path.usesInterfaceType(.wifi) ? "wifi" : path.usesInterfaceType(.wiredEthernet) ? "ethernet" : "vpn-or-other"
                self.expensive = path.isExpensive
                self.report("network_changed")
                if path.status == .satisfied { self.call.networkAvailable() }
                if self.failure != nil && path.status == .satisfied { self.reload() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "dev.example.sai.network"))
        timer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            guard UIApplication.shared.applicationState == .active else { return }
            self?.report("connection_check")
        }
        reload()
        let callKitProbe = ProcessInfo.processInfo.arguments.contains("--sai-callkit-probe")
        if callKitProbe || ProcessInfo.processInfo.arguments.contains("--sai-audio-probe") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.call.startAudioProbe(useCallKit: callKitProbe) }
        }
    }
    private func trusted(_ url: URL?) -> Bool {
        url?.scheme == "https" && url?.host == home.host && url?.port == home.port
    }
    func reload() {
        failure = nil; loading = true; ready = false
        var url = URLComponents(url: home, resolvingAgainstBaseURL: false)!
        if let code = pendingPair { url.fragment = "pair=" + code }
        web.load(URLRequest(url: url.url!, timeoutInterval: 25))
    }
    func open(_ url: URL) { pair(url.absoluteString) }
    func pair(_ value: String) {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
        let raw: String?
        if url.scheme == "sai", url.host == "pair" {
            raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value
        } else if trusted(url) {
            raw = URLComponents(string: "https://pair.invalid/?" + (url.fragment ?? ""))?.queryItems?.first(where: { $0.name == "pair" })?.value
        } else { raw = nil }
        guard let code = raw, code.range(of: "^[a-f0-9]{48}$", options: .regularExpression) != nil else {
            failure = "That doesn’t look like an SAI pairing link."; return
        }
        pendingPair = code; needsPairing = false; reload()
    }
    func foreground() {
        incoming.foreground()
        MessageNotifications.shared.refresh()
        watch.refresh()
        vision.setForeground(true)
        keyboard.refresh()
        guard ready else { if failure != nil { reload() }; return }
        deliverCallEvent(call.snapshot())
        web.evaluateJavaScript("window.saiResume?.()", completionHandler: nil)
        if call.active { call.diagnostic("foreground") }
        report("foreground")
    }
    func background() {
        incoming.background()
        vision.setForeground(false)
        UIApplication.shared.isIdleTimerDisabled = false
        if call.active { call.markBackground(); return }
        web.evaluateJavaScript("window.saiSuspend?.()", completionHandler: nil)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func deliverCallEvent(_ event: [String: Any]) {
        guard ready, UIApplication.shared.applicationState == .active,
              let bytes = try? JSONSerialization.data(withJSONObject: event), let json = String(data: bytes, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.saiNativeEvent?.(\(json))", completionHandler: nil)
    }
    func report(_ event: String) {
        let data: [String: Any] = ["platform": "ios", "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0", "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown", "device": UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone", "network": network, "expensive": expensive, "event": event]
        if let encoded = try? JSONSerialization.data(withJSONObject: data), let json = String(data: encoded, encoding: .utf8) {
            let local: [String: Any] = data.merging(["at": ISO8601DateFormatter().string(from: Date()), "ready": ready]) { _, new in new }
            if let saved = try? JSONSerialization.data(withJSONObject: local, options: .prettyPrinted), let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? saved.write(to: dir.appendingPathComponent("Connection.json"), options: .atomic)
            }
            if ready { web.evaluateJavaScript("window.saiDeviceCheck?.(\(json))", completionHandler: nil) }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), let data = message.body as? [String: Any], let event = data["event"] as? String else { return }
        switch event {
        case "ready":
            watch.refresh()
            web.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in DispatchQueue.main.async { self?.incoming.configure(cookies: cookies.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == home.host }) } }
            web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                DispatchQueue.main.async { MessageNotifications.shared.configure(home: home, cookies: cookies.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == home.host }) }
            }
            ready = true; loading = false; failure = nil; needsPairing = false; pendingPair = nil; deliverCallEvent(call.snapshot()); deliverCallEvent(vision.snapshot()); report("page_ready")
            keyboard.refresh()
        case "history_synced":
            watch.refresh()
            // Keep a content-free receipt so device synchronization can be verified.
            guard let revision = data["revision"] as? String,
                  revision.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let count = data["count"] as? Int, count >= 0,
                  let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
            let receipt: [String: Any] = ["revision": revision, "count": count,
                "at": ISO8601DateFormatter().string(from: Date()),
                "device": UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"]
            if let bytes = try? JSONSerialization.data(withJSONObject: receipt, options: .prettyPrinted) {
                try? bytes.write(to: dir.appendingPathComponent("HistorySync.json"), options: .atomic)
            }
        case "pairing_failed":
            loading = false; ready = false; needsPairing = true; pendingPair = nil
            failure = String((data["error"] as? String ?? "Please create a fresh pairing link.").prefix(200))
        case "unauthorized":
            watch.refresh()
            ready = false; loading = false; needsPairing = true; pendingPair = nil
        case "native_call_start":
            guard ready else { return }
            callRequest = UUID(); let request = callRequest
            web.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
                DispatchQueue.main.async {
                    guard let self, self.ready, self.callRequest == request else { return }
                    let matching = cookies.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == home.host }
                    self.call.start(home: home, cookies: matching, mode: data["mode"] as? String ?? "classic")
                }
            }
        case "native_outing_start":
            guard ready, let id = call.sharedCameraCallID else { deliverCallEvent(["type":"outing_camera","enabled":false,"cameraStatus":"off","error":"Start a connected voice call first."]); return }
            web.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
                DispatchQueue.main.async {
                    guard let self, self.call.sharedCameraCallID == id else { return }
                    self.vision.start(home:home,cookies:cookies.filter { $0.domain.trimmingCharacters(in:CharacterSet(charactersIn:".")) == home.host },callID:id)
                }
            }
        case "native_outing_stop": vision.stop()
        case "native_call_end": vision.stop(); callRequest = UUID(); call.requestEnd()
        case "native_call_interrupt": call.interrupt()
        case "native_call_mute": call.setMuted(data["muted"] as? Bool ?? false)
        case "native_call_ack": if let seq = data["seq"] as? Int { call.acknowledge(seq) }
        case "voice":
            let state = data["state"] as? String ?? "idle"
            UIApplication.shared.isIdleTimerDisabled = vision.enabled
            if state == "idle" && !call.active { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
            report("voice_" + state)
        case "theme":
            // The page's Appearance setting (system/light/dark) also decides the native surfaces around it.
            let style: UIUserInterfaceStyle = data["theme"] as? String == "dark" ? .dark : data["theme"] as? String == "light" ? .light : .unspecified
            web.overrideUserInterfaceStyle = style
            for scene in UIApplication.shared.connectedScenes { (scene as? UIWindowScene)?.windows.forEach { $0.overrideUserInterfaceStyle = style } }
        case "text_delivered": report("text_delivered")
        case "voice_played": report("voice_played")
        default: break
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Authorization is confirmed by the app after its API request, not by loading HTML.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, self.loading, !self.ready else { return }
            self.loading = false
            self.failure = "The Mac is taking too long to answer. Check that Samantha and Tailscale are running."
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        loading = false; ready = false
        failure = "Can’t reach your Mac right now. Check that Tailscale is connected on this device."
        report("connection_failed")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if trusted(url) { decisionHandler(.allow) }
        else { decisionHandler(.cancel); if url.scheme == "https" { UIApplication.shared.open(url) } }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https" { UIApplication.shared.open(url) }; return nil
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard origin.protocol == "https", origin.host == home.host, origin.port == home.port, type == .microphone else { decisionHandler(.deny); return }
        AVAudioApplication.requestRecordPermission { allowed in
            DispatchQueue.main.async {
                if allowed {
                    do {
                        let session = AVAudioSession.sharedInstance()
                        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
                        try session.setActive(true)
                    } catch { decisionHandler(.deny); return }
                }
                decisionHandler(allowed ? .grant : .deny)
            }
        }
    }
}
