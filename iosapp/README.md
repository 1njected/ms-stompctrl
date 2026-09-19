# MS StompCtrl for iOS

A second front end onto the same client. The browser build is unchanged: this
swaps its transport for an ExternalAccessory one and wraps it in a `WKWebView`,
so `ui.js`, `install.js`, `patches.js` and the rest are the same files, loaded
from `../app`.

Unofficial, and not affiliated with ZOOM — see [NOTICE.md](../NOTICE.md). It can
only be sideloaded: `jp.co.zoom.p1` is ZOOM's registered MFi protocol string, and
App Review requires MFi licensee status or the accessory maker's authorization to
publish an app that declares one. Nothing blocks a build you sign yourself.

```
project.yml     the app; `xcodegen generate` builds StompCtrl.xcodeproj from it
Sources/        Swift: the web view, the custom scheme, the EASession streams
web/            transport-ea.js -- the only JavaScript unique to this build
tests/          everything that checks the build without a device; never ships
```

| | |
|---|---|
| `Sources/WebHost.swift` | The bridge: page messages in, `stompNative*` calls out, and native saving. |
| `Sources/Accessory.swift` | `EASession` streams, the write queue, partial writes. |
| `Sources/AssetSchemeHandler.swift` | Serves the page from `stompctrl://app/` so it gets a real origin, and swaps the transport as it does. |
| `web/transport-ea.js` | iAP1 upward to the app, bare SysEx downward. Replaces `transport.js`, `iap.js`'s host half, `iap-auth.js` and `iap-signature.js`. |
| `tests/run-tests.sh` | The Node suite, the rewrite check, and both Swift targets type-checking. |
| `tests/serve-mock.py` | The whole client in a desktop browser, answered by a recorded capture. |

Everything else — `ui.js`, `install.js`, `patches.js`, `backup.js`, `inventory.js`,
`restore.js`, the editor, the CSS, the HTML — is `../app`, unchanged and shared.
Two folder references in `project.yml` pull it into the bundle at build time
rather than copying it, so there is one copy of every module and it is the one
the browser build and its tests use.

## Why a shim rather than a port

Everything above the transport already speaks iAP1 and has tests to prove it.
Rather than teach eleven call sites a new transport, this file impersonates the
old one: it accepts the iAP frames the app builds, strips them, and hands the
payload to iOS — which owns identification, authentication, the data session and
fragmentation — see Status below.

Not one line above this file differs between the two builds.

## Load order

`transport-ea.js` must load **before** `iap.js`.

`iap.js` publishes `IAPCodec` and then returns early if `globalThis.iapHost`
already exists — its own re-entry guard. Loading the shim first claims `iapHost`,
so `iap.js` contributes its codec and leaves its RFCOMM state machine
uninstalled. The shim touches `IAPCodec` only from inside functions, by which
point `iap.js` has run. `transport-ea.test.cjs` asserts this, because a silent
regression here would put two transports on the page.

## Tests

```sh
tests/run-tests.sh
```

- `transport-ea.test.cjs` — the translation both ways; the runtime surface the
  app binds to, driven through a fake DOM in a `vm` context as `iap.test.cjs`
  does; and a round trip of all 230 frames from
  `tools/protocol-20260908T150705Z.decoded.json`. That capture sits below iAP,
  so its frames are exactly what an `EASession` carries.
- `rewrite-check` — compiles `AssetSchemeHandler` for macOS and runs its HTML
  rewrite against the real `app/index.html`, asserting the shim replaces the
  browser transport, loads before `iap.js`, and disturbs nothing else.
- Both Swift targets type-check against the iOS SDK.

None of this needs the pedal or a device. What it cannot tell you is whether
`localStorage` survives the custom scheme — see below.

## What the synthetic DevACK costs

`install.js:53` waits for iAP `0x41` receipts to confirm each chunk of a `.ZDL`
landed, and iOS consumes the real ones internally. The shim synthesises one per
forwarded `0x43`, which is genuinely weaker: a resolved stream write means iOS
took the bytes, not that the pedal acknowledged them. `install.js:40` had already
concluded the protection is the transaction id rather than the ack, which is what
makes this tolerable — but installs are where to look first if the iOS build ever
misbehaves.

## Building

```sh
brew install xcodegen
xcodegen generate && open StompCtrl.xcodeproj
```

Set your team and change the bundle identifier, then build to a device. The web
app is never copied into this tree: two folder references in `project.yml` pull
in the public repo's `app/` and the `shim/` beside it at build time, so there is
one copy of `ui.js` and the rest, and it is the one the browser build and its
tests use.

## Status

Runs on hardware. Confirmed 2026-09-19: current iOS still grants an iAP1 data
session to the MS-100BT. The pedal answers a MIDI identity request with
`f0 7e 00 06 02 52 5e 00 01 00 31 2e 33 30 f7` — byte-identical to the 2026
capture, so ZOOM, MS-100BT, firmware 1.30 — and the streams open in about 5 ms,
against the 650 ms best case Chrome manages over RFCOMM on macOS. iOS performs
the whole iAP layer before the page is told anything, which is why
`iap-auth.js` and `iap-signature.js` have no counterpart here.

Reading and the session come up; the UI has bugs still being worked out. The synthetic DevACK remains the one place the shim is weaker than
the browser transport, so an install end to end is the thing to watch.

## Still to build

- **A phone pass over the UI.** `ui.css` already breaks at 680px, but that was
  written for a narrow desktop window, not a thumb.
- **Restore.** Least tested in the browser client, and untested here.

If the device checks above go badly, the fallback is not a native rewrite but
JavaScriptCore: `install.js`, `restore.js`, `patch-editor.js`, `patches.js`,
`inventory.js` and `flst.js` contain 1,379 lines between them and touch the DOM
exactly zero times, so the protocol engine can move out of the web view without
being rewritten. Only the ~600 lines of UI would be native.
