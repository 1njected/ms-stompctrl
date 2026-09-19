// Serves the web app from the bundle under a real origin.
//
// A file:// origin in WKWebView gives unreliable localStorage and IndexedDB,
// and effect-store.js, backup.js and disclaimer.js all depend on them -- the FX
// library, the cached patch sync and the risk-acceptance gate. A custom scheme
// gets a proper scheme://host origin instead.
//
// It also decides which transport the page loads, which is why index.html needs
// no iOS-specific markup and the public repo stays unaware this build exists.

import WebKit

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "stompctrl"
    static let origin = "\(scheme)://app/"

    // Searched in order, so web/ shadows the shared copy of any file.
    private let roots: [URL]
    private var live = Set<ObjectIdentifier>()

    init(roots: [URL]) { self.roots = roots }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        live.insert(ObjectIdentifier(task))
        guard let url = task.request.url else { return finish(task, status: 400, body: Data()) }

        var name = String(url.path.dropFirst())          // .path already drops ?v=
        if name.isEmpty { name = "index.html" }

        guard let file = locate(name) else {
            return finish(task, status: 404, body: Data("not found: \(name)".utf8))
        }
        guard var body = try? Data(contentsOf: file) else {
            return finish(task, status: 500, body: Data())
        }
        if name == "index.html", let html = String(data: body, encoding: .utf8) {
            body = Data(Self.chooseTransport(in: html).utf8)
        }
        finish(task, status: 200, body: body, type: Self.mime(for: name))
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(task))
    }

    // A task that has been stopped must not be touched again; WKWebView traps
    // on it.
    private func finish(_ task: WKURLSchemeTask, status: Int, body: Data,
                        type: String = "text/plain; charset=utf-8") {
        guard live.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type,
                                                      "Content-Length": String(body.count)])!
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
        live.remove(ObjectIdentifier(task))
    }

    private func locate(_ name: String) -> URL? {
        for root in roots {
            let candidate = root.appendingPathComponent(name).standardizedFileURL
            // Refuse anything that climbs out of a root.
            guard candidate.path.hasPrefix(root.standardizedFileURL.path) else { continue }
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// Swap the browser transport for the ExternalAccessory one.
    ///
    /// `transport.js` becomes `transport-ea.js` *in place*, which matters: the
    /// shim has to load before `iap.js` so it can claim `iapHost` and leave
    /// `iap.js` contributing only its codec. `iap-auth.js` and
    /// `iap-signature.js` are dropped outright -- iOS performed the
    /// authentication before the streams ever opened.
    static func chooseTransport(in html: String) -> String {
        var out = html.replacingOccurrences(of: "src=\"transport.js",
                                            with: "src=\"transport-ea.js")
        for dropped in ["iap-auth.js", "iap-signature.js"] {
            out = removeScript(dropped, from: out)
        }
        return out
    }

    static func removeScript(_ name: String, from html: String) -> String {
        var out = html
        while let open = out.range(of: "<script src=\"\(name)"),
              let close = out.range(of: "</script>", range: open.upperBound..<out.endIndex) {
            out.removeSubrange(open.lowerBound..<close.upperBound)
        }
        return out
    }

    static func mime(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js":   return "text/javascript; charset=utf-8"
        case "css":  return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "png":  return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg":  return "image/svg+xml"
        case "zip":  return "application/zip"
        case "py":   return "text/plain; charset=utf-8"
        default:     return "application/octet-stream"
        }
    }
}
