# MS StompCtrl for macOS — preview

A native macOS Bluetooth backend with the shared StompCtrl web interface.
Supports macOS 12 or later, on Apple Silicon and Intel Macs.

Unzip and move StompCtrlMac.app to Applications. Pair the MS-100BT in System
Settings → Bluetooth, close other apps connected to it, then launch StompCtrl
and choose Connect pedal. Allow Bluetooth access if macOS requests it.

This preview has an ad-hoc signature, **not an Apple Developer ID signature or
notarization**. macOS Gatekeeper may block a downloaded copy. A Developer
ID-signed and notarized build is needed for normal trusted distribution.

Tested on an Apple Silicon Mac with an MS-100BT: native connection, iAP
signature verification, all 50 patches read with verified checksums, and
reconnection after restart. Intel is compiled but has not been hardware-tested.
Effect installation and restore were not tested in this validation. Back up
before writing to the pedal.

Effect binaries, artwork, personal backups and captured certificates are not
included. Import your own effect files. The app's library and backups are
separate from those in Chrome, Brave and the iOS app.

Unofficial, not affiliated with ZOOM. See NOTICE.md and LICENSE.
