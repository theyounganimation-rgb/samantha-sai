import UIKit
import WebKit

final class SamanthaWKWebView: WKWebView {
    var onLayout: (() -> Void)?
    override func layoutSubviews() { super.layoutSubviews(); onLayout?() }
    override func safeAreaInsetsDidChange() { super.safeAreaInsetsDidChange(); onLayout?() }
    override func didMoveToWindow() { super.didMoveToWindow(); onLayout?() }
}

/// WKWebView's outer scroll view stays fixed. Scrolling inside the conversation and
/// settings sheet is still handled by their own DOM scroll containers.
final class NativeKeyboardLayout: NSObject, UIScrollViewDelegate {
    private weak var web: WKWebView?
    private var observers: [NSObjectProtocol] = []
    private var screenFrame: CGRect?
    private var lastGeometry: String?

    init(web: WKWebView) {
        self.web = web
        super.init()
        web.scrollView.isScrollEnabled = false
        web.scrollView.delegate = self
        (web as? SamanthaWKWebView)?.onLayout = { [weak self] in self?.publish(duration: 0) }
        let center = NotificationCenter.default
        for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self else { return }
                if note.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool == false { return }
                self.screenFrame = note.name == UIResponder.keyboardWillHideNotification ? nil :
                    (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
                self.publish(duration: (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25)
            })
        }
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView.contentOffset != .zero { scrollView.setContentOffset(.zero, animated: false) }
    }

    func refresh() { publish(duration: 0, force: true) }

    private func publish(duration: Double, force: Bool = false) {
        guard let web, let window = web.window else { return }
        let height: CGFloat
        if let screenFrame {
            // Keyboard frames use screen coordinates, not the view's coordinates.
            // Convert first so rotation and a window smaller than the screen work too.
            let inWindow = window.convert(screenFrame, from: window.screen.coordinateSpace)
            let inWeb = web.convert(inWindow, from: window)
            let overlap = web.bounds.intersection(inWeb)
            // A floating iPad keyboard must not lift the entire conversation.
            height = !overlap.isNull && overlap.maxY >= web.bounds.maxY - 1 && overlap.width >= web.bounds.width * 0.9 ? overlap.height : 0
        } else { height = 0 }
        // SwiftUI may give an edge-to-edge WKWebView zero safe-area insets.
        // The window retains the real status-bar/home-indicator insets. Report
        // these after layout and on every change, never freeze a startup zero.
        let safeTop = window.safeAreaInsets.top
        let safeBottom = window.safeAreaInsets.bottom
        let geometry = "height:\(height),safeTop:\(safeTop),safeBottom:\(safeBottom)"
        guard force || geometry != lastGeometry else { return }
        lastGeometry = geometry
        let state = "{\(geometry),duration:\(max(0, duration))}"
        // Retain a notification that arrives before app.js finishes loading.
        web.evaluateJavaScript("window.saiKeyboardState = \(state); window.saiKeyboard?.(window.saiKeyboardState)", completionHandler: nil)
    }
}
