import AppKit
import WebKit

final class WebHost: NSViewController, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView!
    private var diagnostics: [String] = []
    private let bluetooth = BluetoothTransport()

    override func loadView() {
        let config = WKWebViewConfiguration()
        let roots = ["web", "app"].compactMap { Bundle.main.url(forResource: $0, withExtension: nil) }
        config.setURLSchemeHandler(AssetSchemeHandler(roots: roots), forURLScheme: AssetSchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "stomp")
        let diagnosticScript = """
        (()=>{const report=text=>{try{webkit.messageHandlers.stomp.postMessage({action:'diagnostic',text}).catch(()=>{});}catch{}};
        for(const level of ['log','warn','error']){const original=console[level];console[level]=function(...args){original.apply(console,args);report(args.map(x=>{try{return typeof x==='string'?x:JSON.stringify(x);}catch{return String(x);}}).join(' '));};}
        addEventListener('error',e=>report('ERROR '+e.message+' '+e.filename+':'+e.lineno));
        addEventListener('unhandledrejection',e=>report('REJECTION '+String(e.reason)));})();
        """
        config.userContentController.addUserScript(WKUserScript(source: diagnosticScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        bluetooth.diagnostic = { [weak self] in self?.record($0) }
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        view = webView
        bluetooth.receive = { [weak self] bytes in self?.call("stompMacReceive", bytes) }
        bluetooth.closed = { [weak self] in self?.call("stompMacClosed", NSNull()) }
        webView.load(URLRequest(url: URL(string: AssetSchemeHandler.origin)!))
    }

    func stop() { bluetooth.disconnect() }

    // Give shared iAP a chance to close its data session before releasing RFCOMM.
    // A broken web process must not prevent the native application from quitting.
    func shutdown(_ completion: @escaping () -> Void) {
        var finished = false
        let finish = { [weak self] in
            guard !finished else { return }; finished = true
            self?.stop(); completion()
        }
        webView.callAsyncJavaScript("await globalThis.closeStompPort?.()", arguments: [:], in: nil, in: .page) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: finish)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == AssetSchemeHandler.scheme,
              message.frameInfo.request.url?.host == "app",
              let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "Untrusted bridge request."); return
        }
        switch action {
        case "diagnostic": record(String((body["text"] as? String ?? "").prefix(3000))); replyHandler(true, nil)
        case "connect": bluetooth.connect(replyHandler)
        case "disconnect": bluetooth.disconnect(); replyHandler(true, nil)
        case "write":
            guard let numbers = body["bytes"] as? [NSNumber], numbers.count <= 65536,
                  numbers.allSatisfy({ $0.doubleValue >= 0 && $0.doubleValue <= 255 && $0.doubleValue.rounded() == $0.doubleValue }) else {
                replyHandler(nil, "Invalid Bluetooth bytes."); return
            }
            bluetooth.write(numbers.map { $0.uint8Value }, reply: replyHandler)
        case "save":
            guard let base64 = body["base64"] as? String, let data = Data(base64Encoded: base64),
                  let filename = body["filename"] as? String else { replyHandler(nil, "Invalid file."); return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (filename as NSString).lastPathComponent
            panel.begin { result in
                guard result == .OK, let url = panel.url else { replyHandler(nil, "Save cancelled."); return }
                do { try data.write(to: url, options: .atomic); replyHandler(true, nil) }
                catch { replyHandler(nil, error.localizedDescription) }
            }
        default: replyHandler(nil, "Unknown bridge action.")
        }
    }

    private func record(_ text: String) {
        diagnostics.append("\(ISO8601DateFormatter().string(from: Date())) \(text)")
        if diagnostics.count > 1000 { diagnostics.removeFirst(diagnostics.count - 1000) }
    }
    @objc func showDiagnostics() {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 850, height: 550),
                            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "Connection diagnostics"
        let scroll = NSScrollView(frame: panel.contentView!.bounds)
        scroll.autoresizingMask = [.width, .height]; scroll.hasVerticalScroller = true
        let text = NSTextView(frame: scroll.bounds)
        text.isEditable = false; text.isVerticallyResizable = true
        text.autoresizingMask = [.width]; text.string = diagnostics.joined(separator: "\n")
        text.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        scroll.documentView = text; panel.contentView = scroll
        panel.isReleasedWhenClosed = false
        diagnosticPanel = panel
        panel.center(); panel.makeKeyAndOrderFront(nil)
    }
    private var diagnosticPanel: NSPanel?

    private func call(_ name: String, _ value: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("globalThis.\(name)?.apply(null, \(json))", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == AssetSchemeHandler.scheme && url.host == "app" {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        bluetooth.disconnect()
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { bluetooth.disconnect(); webView.reload() }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}
