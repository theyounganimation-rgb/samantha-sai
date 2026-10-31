#if DEBUG
import WebKit

/// Opt-in UI-test instrumentation, containing geometry only, never chat contents.
/// Samples presentation-layer positions during the animation, not only its end points.
final class KeyboardLayoutProbe: NSObject, WKScriptMessageHandler {
    private weak var web: WKWebView?
    private var samples: [[String: Any]] = []

    private init(web: WKWebView) { self.web = web }

    static func install(on web: WKWebView) {
        let controller = web.configuration.userContentController
        controller.add(KeyboardLayoutProbe(web: web), name: "saiKeyboardProbe")
        controller.addUserScript(WKUserScript(source: """
        (() => {
          let end = 0, sequence = 0;
          function sample() {
            const button = document.querySelector('#call-shortcut');
            if (button) {
              const r = button.getBoundingClientRect();
              window.webkit.messageHandlers.saiKeyboardProbe.postMessage({
                sequence, y:r.y, height:r.height, viewport:innerHeight,
                keyboard:window.saiKeyboardState?.height || 0,
                sheet:!!document.querySelector('dialog[open]'),
                done:performance.now() >= end
              });
            }
            if (performance.now() < end) requestAnimationFrame(sample);
          }
          function start() {
            const running = performance.now() < end;
            end = performance.now()+1100; sequence++;
            if (!running) requestAnimationFrame(sample);
          }
          document.addEventListener('focusin',start);
          document.addEventListener('focusout',start);
        })();
        """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    #if targetEnvironment(simulator)
    /// Exercise the real page and keyboard without pairing a simulator or making agent turns.
    static func installFixture(on web: WKWebView) {
        web.configuration.userContentController.addUserScript(WKUserScript(source: """
        (() => {
          const original = window.fetch;
          window.fetch = (input, options) => {
            const url = new URL(typeof input === 'string' ? input : input.url, location.href);
            if (!url.pathname.startsWith('/api/')) return original(input, options);
            const body = url.pathname === '/api/status'
              ? {gateway:true,camera:{status:'unavailable'},voice:{connected:false}}
              : url.pathname === '/api/history'
              ? {messages:Array.from({length:30},(_,i)=>({id:'fixture'+i,role:i%2?'assistant':'user',timestamp:Date.now()-900000+i*1000,text:'Keyboard layout fixture '+i})),revision:'fixture',epoch:'fixture',sequence:1}
              : {ok:true};
            return Promise.resolve(new Response(JSON.stringify(body), {headers:{'Content-Type':'application/json'}}));
          };
          window.EventSource = class { close() {} };
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    #endif

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let web, let window = web.window,
              var sample = message.body as? [String: Any], let y = sample["y"] as? Double else { return }
        let frame = web.layer.presentation()?.convert(web.bounds, to: window.layer.presentation()) ?? web.convert(web.bounds, to: window)
        sample["screenY"] = Double(frame.minY) + y
        sample["webY"] = Double(frame.minY)
        sample["webHeight"] = Double(frame.height)
        sample["safeTop"] = Double(window.safeAreaInsets.top)
        samples.append(sample)
        if sample["done"] as? Bool == true,
           let data = try? JSONSerialization.data(withJSONObject: samples, options: [.prettyPrinted, .sortedKeys]),
           let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? data.write(to: dir.appendingPathComponent("KeyboardLayoutProbe.json"), options: .atomic)
        }
    }
}
#endif
