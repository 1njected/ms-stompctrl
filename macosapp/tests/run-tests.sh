#!/bin/sh
set -eu
cd "$(dirname "$0")"
node --test native-serial.test.cjs
check_dir=$(mktemp -d /tmp/stomp-macos-tests.XXXXXX)
xcrun swiftc -module-cache-path "$check_dir/cache" ../Sources/AssetSchemeHandler.swift rewrite-check/main.swift -o "$check_dir/rewrite-check"
"$check_dir/rewrite-check" ../../app/index.html
xcrun swiftc -typecheck -parse-as-library -module-cache-path "$check_dir/cache" ../Sources/*.swift
