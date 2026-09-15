# Connecting to the MS-100BT

The connection is the least reliable part of this project. Most "the app is
broken" reports are one of the states below. Everything here is measured, including
the remedies that do nothing.

## The short version

| Symptom | What it means |
|---|---|
| Port opens, pedal sends `55 04 00 38 00 01 C3` | Working. That frame is StartIDPS. |
| `open()` fails after ~10 s | No RFCOMM session. See *Refusing sessions*. |
| Port opens, then total silence | Same fault, different shape. A successful open is **not** proof of a working link. |
| Commands acked, no answers | Pedal application layer has stopped. Power-cycle it. |
| One frame repeated every ~500 ms | Host→pedal direction has stalled. It usually recovers. |

## The one-host rule

**The pedal serves exactly one host, and whoever holds the Bluetooth (ACL) link
locks out everyone else — including a host that cannot actually use it.**

This is the single most useful fact here. A Mac holding a link it could not get
RFCOMM over prevented an iPad from *pairing at all*. Releasing the link let the
iPad connect immediately:

```sh
tools/macos-bt-probe/bt-release        # drops the ACL link, keeps the pairing
```

Releasing does not restore the releasing machine's own access. It unblocks other
hosts.

## Refusing sessions

The failure looks like this:

- A live SDP query **succeeds** — the pedal is powered, in range, answering
- No RFCOMM channel can be opened, from Chrome **or** from native code
- No success callback and no failure callback; the open just never completes

SDP carries no session state, which is why it keeps answering while sessions are
refused. Diagnose it without the browser:

```sh
tools/macos-bt-probe/sdp-dump --refresh     # status=0 means the pedal is answering
tools/macos-bt-probe/rfcomm-listen 1 12     # channel 1 is the iAP service
```

If SDP succeeds and `rfcomm-listen` receives nothing, the fault is a session,
not the radio, not Chrome, and not the app.

**A pedal power cycle is the only thing measured to clear this reliably.**

### What does not work

Measured, not assumed:

- `sudo pkill bluetoothd`
- Quitting and restarting Chrome
- A full macOS restart — the state survived a reboot of both Mac and pedal
- Releasing the ACL link (unblocks *other* hosts, not the local one)
- Re-pairing — worked four times, then did not

### What the diagnosis is not

**Not a corrupt SDP cache.** The cached records are correct and identical in the
healthy and broken states, and a forced live query succeeds while the pedal is
otherwise unreachable: `iAP → RFCOMM channel 1`, `SPP → channel 2`.

**Not readable from the `Services` bitmask.** The broken state has been observed
both with `0x802000 < Braille ACL >` and with a healthy `0x800000 < ACL >`, so
the bitmask does not distinguish them. Trust the RFCOMM result.

macOS labels the pedal *Minor Type: Handsfree* from its Class of Device
(`0x240408`). It advertises **no** Handsfree service — only SPP and the iAP
service — so nothing is connecting to a headset profile, and blacklisting one
would have nothing to bite on.

## Acked but never answered

Every command gets its iAP `0x41` acknowledgement within ~40 ms, and no `0x42`
payload ever arrives — from any subsystem: filesystem, audio, patch, identity.
The pedal's Bluetooth stack is running; the part that handles ZOOM SysEx has
stopped.

Nothing host-side recovers this. **Switch the pedal off and on.** The app
detects a run of these and says so rather than reporting a write timeout.

## One-way stalls

The pedal re-sends one frame every ~500 ms while every acknowledgement we send
is buffered and dropped. Measured once at eleven copies over five seconds,
after which the pedal gave up and the link recovered by itself.

The app absorbs this: delivery is retried with widening patience, and the
response deadline does not start until the pedal confirms delivery. A repeated
transaction is logged as `link_one_way` and its duplicate payloads are discarded
rather than appended to the file list.

## Picking the right port

The pedal advertises two services. Chrome will offer both.

| Service | UUID | RFCOMM | |
|---|---|---|---|
| iAP accessory | `00000000-deca-fade-deca-deafdecacaff` | 1 | **use this** |
| Serial Port (SPP) | `00001101-0000-1000-8000-00805f9b34fb` | 2 | never answers |

Chrome reports the UUID it *requested*, not the channel that was actually
connected, so the port info cannot tell you whether the link is good. Only
received bytes can.

## Identification is the pedal's move

The host never speaks first. The pedal sends StartIDPS and everything follows
from it, so **nothing the host sends can prompt a silent pedal** — measured
against `RequestIdentify`, `GetAccessoryInfo` and `StartIDPS`, all written with
zero backpressure, none answered.

## Pedal-side reset

The pedal has its own Bluetooth menu:

```
MENU → SETTINGS → Bluetooth → PAIRING
```

There is no SysEx command worth looking for here: any command that reset
Bluetooth would have to arrive over Bluetooth.
