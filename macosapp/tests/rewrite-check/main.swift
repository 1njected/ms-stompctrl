import Foundation
let html = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let out = AssetSchemeHandler.chooseTransport(in: html)
precondition(out.components(separatedBy: "native-serial.js").count == 2)
precondition(out.range(of: "native-serial.js")!.lowerBound < out.range(of: "src=\"transport.js")!.lowerBound)
for name in ["iap.js", "iap-auth.js", "iap-signature.js", "ui.js"] {
    precondition(out.contains("src=\"\(name)"))
}
precondition(out.replacingOccurrences(of: "<script src=\"native-serial.js\"></script>\n", with: "") == html)
print("Shared frontend preserved, native adapter loads first.")
