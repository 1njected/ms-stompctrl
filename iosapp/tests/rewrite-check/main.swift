// Checks AssetSchemeHandler.chooseTransport against the real index.html:
// the page the iOS app serves has to load the shim in place of the browser
// transport, before iap.js, and disturb nothing else.
//
// Run through ../run-tests.sh.
import Foundation

// argv[1]: the page to check. argv[2], optional: where to write the result for
// run-tests.sh to compare against the dev server's copy of the same rule.
let page = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "../app/index.html"
let html = try! String(contentsOfFile: page, encoding: .utf8)
let out = AssetSchemeHandler.chooseTransport(in: html)

func check(_ ok: Bool, _ what: String) {
    print((ok ? "ok   " : "FAIL ") + what)
    if !ok { exit(1) }
}
func scripts(_ s: String) -> [String] {
    var names: [String] = [], rest = Substring(s)
    while let open = rest.range(of: "<script src=\"") {
        let after = rest[open.upperBound...]
        guard let quote = after.firstIndex(of: "\"") else { break }
        names.append(String(after[..<quote]).components(separatedBy: "?")[0])
        rest = after[quote...]
    }
    return names
}
let before = scripts(html), after = scripts(out)
check(before.contains("transport.js"), "the source page loads transport.js")
check(!after.contains("transport.js"), "transport.js is gone")
check(after.contains("transport-ea.js"), "transport-ea.js took its place")
check(!after.contains("iap-auth.js") && !after.contains("iap-signature.js"),
      "the authentication scripts are dropped")
check(after.contains("iap.js"), "iap.js stays, for its codec")
let ea = after.firstIndex(of: "transport-ea.js")!, iap = after.firstIndex(of: "iap.js")!
check(ea < iap, "the shim loads before iap.js, so it claims iapHost first")
check(after.count == before.count - 2, "every other script survives (\(after.count) of \(before.count))")
let untouched = before.filter { !["transport.js", "iap-auth.js", "iap-signature.js"].contains($0) }
check(untouched.allSatisfy { after.contains($0) }, "none of the shared modules were disturbed")
check(out.contains("?v="), "cache-busting query strings are preserved")
print("\nload order: " + after.joined(separator: " -> "))

// Hand the result to run-tests.sh, which compares it with the dev server's own
// copy of this rule. Two implementations of the same rewrite is a drift risk;
// this is what stops it being a silent one.
if CommandLine.arguments.count > 2 {
    try! out.write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)
}
