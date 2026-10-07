# Native Bluetooth probes for the MS-100BT

Built because the browser cannot tell you *why* a port opened and stayed silent.
Chrome reports the service UUID it **requested**, not the channel macOS actually
connected, so every question below is unanswerable from inside the page.

    swiftc -O -framework IOBluetooth -o sdp-dump sdp-dump.swift

All four need the pedal's BD address, which is **not** in this source -- it is a
personal device identifier, so the published copy carries a placeholder and the
tools refuse to run without being told:

    export MS100BT_ADDR=$(system_profiler SPBluetoothDataType \
      | grep -A1 "ZOOM MS-100BT" | grep Address | sed 's/.*: //' | tr ':' '-')

| tool | question it answers |
|---|---|
| `sdp-dump [--refresh]` | what services/channels macOS has for the pedal; `--refresh` forces a **live** over-the-air SDP query |
| `rfcomm-listen <ch> [secs]` | can an RFCOMM channel be opened **by explicit number**, bypassing UUID lookup, and does the pedal send anything |
| `bt-kick` | drop the ACL link without unpairing, then retry channel 1 |
| `bt-release` | drop the ACL link and do **not** reconnect, so another host can take the pedal |
| `bt-hold` | hold the baseband link up and nothing else (no RFCOMM channel, so the pedal's one channel stays free). Written to test whether that alone lets Chrome connect -- it does not; see docs/bluetooth.md |
| `iap-listen` | listen for an accessory-INITIATED channel. Negative result: the pedal never knocks. Note macOS only accepts an inbound channel for a service it publishes, and this publishes none |
| `iap-spike` | can a NATIVE transport reach an open ZOOM data session? Walks the same iAP1 handshake as `app/iap.js` -- identification, then `0x3F` on `jp.co.zoom.p1` -- and stops there. Reads and writes nothing else. |

## Measured 2026-09-13 evening

- `sdp-dump --refresh` → **status=0**, records correct: iAP `deca-fade` → **channel 1**, SPP `1101` → channel 2.
  So a cached/corrupt SDP record is **not** the cause. A live SDP query also proves
  the pedal is powered, reachable and answering over the air.
- `rfcomm-listen 1` and `rfcomm-listen 2` → the open callback **never fires**,
  neither success nor failure, including on a freshly re-established ACL link.
- `bt-kick` → `closeConnection()` drops the link, but macOS re-establishes it at once.

## Measured 2026-09-15

The pedal serves **one host**, and whoever holds the ACL link locks out everyone else --
including a host that cannot actually use it. An iPad could not pair at all while this Mac
held a link it could not get RFCOMM over; `bt-release` dropped the link and the iPad
connected immediately. Releasing does **not** restore this Mac's own access, so it unblocks
other hosts rather than fixing the local fault.

The Services bitmask is **not** a reliable discriminator, contrary to the 2026-09-13 note
above: the same broken state (SDP answers, RFCOMM refused) was later observed with a
healthy `0x800000 < ACL >`. Trust the RFCOMM result, not the bitmask.

Caveat: these tools have never been observed completing an RFCOMM open *successfully*,
so the RFCOMM negative is from an instrument unvalidated for that specific operation.
The SDP success validates Bluetooth access generally, not the RFCOMM path.
