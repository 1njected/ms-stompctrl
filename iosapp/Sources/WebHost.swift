// The bridge. JS -> native arrives as one message handler; native -> JS goes
// back through evaluateJavaScript, calling the three entry points
// transport-ea.js publishes.
//
//   JS  -> native : {action:"connect"|"disconnect"}
//                   {action:"write", seq:1, hex:"f0 52 ..."}
//                   {action:"save", filename:"...", base64:"..."}
//   native -> JS  : stompNativeState('open'|'closed')
//                   stompNativeReceive('<hex>')
//                   stompNativeWritten(seq)
//                   stompNativeError('<message>')

import UIKit
import WebKit

final class WebHost: UIViewController, WKScriptMessageHandler, AccessoryDelegate, WKNavigationDelegate {
    private var webView: WKWebView!
    private let accessory = Accessory()

    override func viewDidLoad() {
        super.viewDidLoad()
        accessory.delegate = self

        let shared = Bundle.main.url(forResource: "app", withExtension: nil)
        let iosOnly = Bundle.main.url(forResource: "web", withExtension: nil)
        let handler = AssetSchemeHandler(roots: [iosOnly, shared].compactMap { $0 })

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: AssetSchemeHandler.scheme)
        config.userContentController.add(self, name: "stomp")
        // The page is ours and reads local files only; no reason to fetch out.
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            // Safe area, not the raw bounds: pinned to the bottom of the view
            // the page ran under the home indicator, so the last row of a
            // full-height panel -- the patch editor's Save and Cancel -- sat
            // under it. 100dvh then measures the area the person can see.
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        if let start = URL(string: AssetSchemeHandler.origin + "index.html") {
            webView.load(URLRequest(url: start))
        }
    }

    // MARK: - JS -> native

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "connect":
            accessory.connect()
        case "disconnect":
            accessory.disconnect()
        case "write":
            guard let hex = body["hex"] as? String else { return }
            accessory.write(Self.bytes(fromHex: hex))
            // The page waits on this before calling the write finished, so its
            // backpressure figures mean something and the synthetic DevACK is
            // not raised before the bytes have gone anywhere.
            if let seq = body["seq"] as? Int { acknowledgeWrite(seq) }
        case "save":
            let filename = body["filename"] as? String ?? "ms-stompctrl.bin"
            save(base64: body["base64"] as? String ?? "", as: filename)
        default:
            break
        }
    }

    // MARK: - native -> JS

    func accessoryDidOpen(name: String) { call("stompNativeState", "open") }
    func accessoryDidClose() { call("stompNativeState", "closed") }
    func accessoryDidReceive(_ bytes: [UInt8]) { call("stompNativeReceive", Self.hex(bytes)) }
    func accessoryDidFail(_ message: String) { call("stompNativeError", message) }

    private func acknowledgeWrite(_ seq: Int) {
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript("stompNativeWritten(\(seq))", completionHandler: nil)
        }
    }

    private func call(_ function: String, _ argument: String) {
        // JSON-encode the argument so a quote or backslash in a message cannot
        // break out of the call.
        let data = try? JSONSerialization.data(withJSONObject: [argument])
        let list = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        let script = "\(function).apply(null, \(list))"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    // MARK: - Saving
    //
    // `a.download` does nothing in WKWebView, so backup.js, bundle.js,
    // effect-store.js and saveProtocolLog route their output here instead.

    private func save(base64: String, as filename: String) {
        guard let data = Data(base64Encoded: base64) else {
            call("stompNativeError", "Could not decode \(filename)")
            return
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            call("stompNativeError", "Could not write \(filename): \(error)")
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(
            x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        present(sheet, animated: true)
    }

    // MARK: - Hex

    static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined(separator: " ")
    }

    static func bytes(fromHex text: String) -> [UInt8] {
        text.split(whereSeparator: { $0 == " " || $0 == "\n" })
            .compactMap { UInt8($0, radix: 16) }
    }
}
