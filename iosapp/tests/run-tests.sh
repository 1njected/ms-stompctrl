#!/bin/sh
# Everything about the iOS build that can be checked without a device.
set -e
cd "$(dirname "$0")"

echo "--- transport-ea.test.cjs"
node transport-ea.test.cjs

echo "\n--- index.html rewrite"
out=$(mktemp -d)
xcrun swiftc -target arm64-apple-macos12.0 \
  ../Sources/AssetSchemeHandler.swift rewrite-check/main.swift -o "$out/rewrite-check"
"$out/rewrite-check" ../../app/index.html "$out/swift.html"

echo "\n--- the dev server rewrites identically"
python3 - "$out/swift.html" <<'EOF'
import importlib.util, sys, pathlib
spec = importlib.util.spec_from_file_location("s", "serve-mock.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
mine = m.choose_transport(pathlib.Path("../../app/index.html").read_text())
theirs = pathlib.Path(sys.argv[1]).read_text()
if mine != theirs:
    import difflib
    print("".join(difflib.unified_diff(theirs.splitlines(True), mine.splitlines(True),
                                       "AssetSchemeHandler.swift", "serve-mock.py"))[:2000])
    raise SystemExit("the Swift and Python rewrites disagree")
print("byte-identical (%d bytes)" % len(mine))
EOF
rm -rf "$out"

echo "\n--- Swift type-check (iOS SDK)"
xcrun --sdk iphoneos swiftc -typecheck -parse-as-library -target arm64-apple-ios15.0 \
  ../Sources/*.swift
echo "type-checks"
