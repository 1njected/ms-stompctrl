// Fetches ZOOM's StompShare catalog for the page, which cannot itself: the
// server sends no CORS headers. Two requests only, both on ZOOM's archive
// path, so the page cannot use this to reach anywhere else. Unzipping, effect
// identity and storage stay in effect-store.js, shared with the browser build.
//
// The same file sits in iosapp/Sources and macosapp/Sources; keep them equal.

import Foundation

enum ZoomCatalog {
    static let base = "https://www.zoom.co.jp/archive/stomp_share/Stomps/"

    /// `[{directory, zdl, name}]`, sorted by catalog key as download-effects.py does.
    static func list(_ reply: @escaping (Any?, String?) -> Void) {
        get(base + "ExtStomps.plist") { data, error in
            guard let data else { return reply(nil, error) }
            guard let root = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  let stomps = root["Stomps"] as? [String: [String: Any]] else {
                return reply(nil, "The ZOOM catalog could not be read.")
            }
            let items: [[String: String]] = stomps.keys.sorted().compactMap { key in
                guard let entry = stomps[key],
                      let directory = entry["directory"] as? String, safe(directory),
                      let zdl = entry["zdl"] as? String else { return nil }
                return ["directory": directory, "zdl": zdl, "name": entry["name"] as? String ?? directory]
            }
            reply(items, nil)
        }
    }

    /// One effect package, base64: a reply cannot carry raw bytes.
    static func package(_ directory: String, _ reply: @escaping (Any?, String?) -> Void) {
        guard safe(directory) else { return reply(nil, "Invalid package name.") }
        get(base + directory + ".zip") { data, error in
            reply(data?.base64EncodedString(), error)
        }
    }

    /// A bare name: no separators or dot-segments that could leave the path.
    private static func safe(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." &&
            name.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || "_-. ".unicodeScalars.contains($0) }
    }

    private static func get(_ address: String, _ done: @escaping (Data?, String?) -> Void) {
        guard let url = URL(string: address.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "") else {
            return done(nil, "Invalid URL.")
        }
        URLSession.shared.dataTask(with: url) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                if let error { done(nil, error.localizedDescription) }
                else if status != 200 { done(nil, "ZOOM answered HTTP \(status).") }
                else { done(data ?? Data(), nil) }
            }
        }.resume()
    }
}
