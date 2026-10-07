# MS StompCtrl for macOS

The same `../app` frontend as the browser and iOS editions, hosted in WKWebView,
with native IOBluetooth RFCOMM instead of Chrome Web Serial. Requires macOS 12+
and a paired ZOOM MS-100BT. No Bluetooth address is stored in the source.

## Build and run

Install Xcode and XcodeGen (`brew install xcodegen`), then from this directory:

```sh
xcodegen generate
xcodebuild -project StompCtrlMac.xcodeproj -scheme StompCtrlMac \
  -configuration Debug -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
open build/Build/Products/Debug/StompCtrlMac.app
```

For a signed build, open the generated project in Xcode and select your team.
The local build is not sandboxed. Bluetooth usage descriptions are included;
allow Bluetooth access if macOS asks. Distribution signing/notarization is not
configured. The generated project, plist and build products are ignored.

Pair the pedal in System Settings first, close other apps holding it, then press
**Connect pedal**. The app selects the single paired device named MS-100BT. If
multiple matching devices are paired it reports the ambiguity rather than
silently choosing one. **Sync from pedal** reads all 50 saved patches without
changing them. File imports use the native open panel and downloads use Save As.
Backups and the effect library belong to this app's WebKit storage, separately
from Chrome and Brave.

## What changes below the frontend

- `BluetoothTransport.swift` explicitly opens/authenticates the baseband link,
  then opens **RFCOMM channel 1** directly. No Chromium SDP/socket wrapper.
- Pending channel opens are closed and retried every 400 ms, with a 30-second
  connection deadline, following the successful `iap-spike --race` experiment.
  Retrying stops as soon as the current channel opens. Stale channel callbacks
  are ignored, and close/reload/quit release the channel.
- Writes are serialized and split at the negotiated RFCOMM MTU. Their promises
  resolve only after native write completion. A 15-second stalled write closes
  the transport; it is never retried automatically because bytes may have landed.
- `web/native-serial.js` supplies the small Web Serial surface used by
  `app/transport.js`. It deliberately omits Chrome's `connected` property so a
  paired but currently disconnected device can actually be opened.
- `AssetSchemeHandler.swift` inserts that adapter before the unchanged transport.
  `iap.js`, `iap-auth.js` and `iap-signature.js` still perform identification,
  certificate capture, signature verification and session handling. **No fake
  pedal ACKs or authentication bypasses.**
- Only bundled main-frame content can invoke the native bridge. External links
  open in the default browser; file access is limited to bundled resource roots.

The connection deadline covers native channel retries; the shared frontend can
retry a failed open too. Initial baseband/authentication calls are synchronous
IOBluetooth calls and can briefly pause the window. This avoids changing the
ordering that worked in the native probe, but is a remaining responsiveness
limitation when the pedal is unreachable.

**Connection Diagnostics…** (⌘D) shows a bounded in-memory snapshot of native
connection progress and frontend logs. Reopen it to refresh. Logs can contain
pedal identification/certificate data; they are not written into the repo.

## Validation

```sh
tests/run-tests.sh
```

Checks byte fidelity (including early receive), write backpressure and errors,
reconnects, unexpected disconnects, binary saving, the real HTML rewrite, and
Swift type-checking. No hardware required.

Live verification on 2026-10-07:

- Native channel opened; shared frontend reached **Pedal ready**.
- All **50 saved patches** read with **all checksums verified**.
- Cached backup survived quitting and reopening the app.
- A second connection opened channel 1 in approximately five seconds and reached
  Pedal ready again.

These measurements establish a working native path on the tested Mac/pedal,
not a universal macOS Bluetooth fix. Effect installation and restore write to
flash and were not exercised as part of this validation.

Unofficial; not affiliated with ZOOM. See [NOTICE.md](../NOTICE.md).

## GitHub release packaging

```sh
scripts/release.sh 0.1.0 1
```

Produces `build/release/MS-StompCtrl-macOS-0.1.0-universal.zip` and its SHA-256
checksum. The Release build contains both arm64 and x86_64, has versioned bundle
metadata and an ad-hoc signature. It is **not Developer ID signed or notarized**;
see [release notes](RELEASE-NOTES.md). The script stages only tracked public
frontend resources, excluding local effects, artwork, tests and captures, and
includes LICENSE and NOTICE.md. Build intermediates remain in the printed
`/tmp/stomp-release.*` directory for inspection.

The `macOS preview release` GitHub Actions workflow supports two paths:

- **Run workflow:** enter a numeric `X.Y.Z` version and download the resulting
  `macOS-preview` artifact. This creates no GitHub Release.
- **Push a `macos-vX.Y.Z` tag:** tests/builds the app, then creates a **draft
  prerelease** with the ZIP, checksum and release notes. Review it in GitHub
  Releases and publish when ready.

Commit the macOS sources and workflow before tagging. The workflow needs no
Apple signing secrets. Adding Developer ID distribution later requires signing
with a Developer ID Application certificate, notarizing with Apple's notary
service, and stapling the ticket before creating the ZIP.
