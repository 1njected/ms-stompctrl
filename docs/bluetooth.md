# Connecting to the MS-100BT

The connection is the least reliable part of this project. Most "the app is
broken" reports are one of the states below. Everything here is measured, including
the remedies that do nothing.

## The short version

| Symptom | What it means |
|---|---|
| Port opens, pedal sends `55 04 00 38 00 01 C3` | Working. That frame is StartIDPS. |
| `open()` fails after ~10 s | The RFCOMM open window was missed; see *The channel has to be opened in a window*. Not a pedal fault. |
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

**`rfcomm-listen` on channel 1 is not a free observation. [V]** It takes the
pedal's one host slot and, on a healthy link, **consumes the StartIDPS** —
identification is the pedal's move and it makes that move once per link. The
probe then exits without finishing identification, so the pedal can be left
believing it has a host and the next Chrome connect opens the port and hears
nothing: `silent_after_open`. Measured 2026-10-06 by doing exactly that to a
working pedal. Use **channel 2** when you only need to touch the link; it is
silent and costs no StartIDPS. Give channel 1 at least 15 s, too: the open can
take 4 s and a shorter window looks like a failure that is not one.

**The channel has to be opened in a window, and the browser cannot reach it. [V]**

Solved 2026-10-07. Everything in this section that previously recommended
re-pairing, power cycles or link-waking was describing side effects of that
window, not causes. Those remedies "worked" when they happened to leave the
pedal freshly appeared and the link cold; they failed, unpredictably, when they
did not.

**What is actually true.** A `connect-on-demand` RFCOMM open on macOS fails:
`openRFCOMMChannelAsync` returns `kIOReturnSuccess` and the delegate is never
called. Retrying the open every **400 ms** from a cold link, across a pedal
power cycle, the channel comes up — measured at 33 s and 48 s of retrying in two
runs. This matches a known unfixed macOS regression reported since Monterey
12.0.1 (Apple Developer Forums 697032, FB9967957), including the "fails to open
entirely" shape, for which no workaround is published.

Two facts kill the theories that came before it:

- **The pedal was never refusing us.** While our opens were failing,
  `bluetoothd` was logging `rfcommDataInd for link: 0x102, len: 0x7` every
  **7.578 s** — StartIDPS arriving, at exactly the retransmit interval, going to
  no consumer. Read it with:

      /usr/bin/log show --last 2m --style compact \
        --predicate 'subsystem == "com.apple.bluetooth" AND category == "Server.RFCOMMChannel"'

  (`log` alone is a zsh builtin and will say "too many arguments"; use the
  absolute path. The same mistake made this look unavailable on iOS too.)

- **The pedal does not initiate, and the bond is fine.** An HCI capture from a
  working iPad (Apple's Bluetooth logging profile, decoded from
  `/var/mobile/Library/Logs/Bluetooth/*.pklg`) shows `HCI_Create_Connection`
  outbound, **no** `HCI_Connection_Request` anywhere, `HCI_Link_Key_Request_Reply`
  — so no re-pair — then L2CAP PSM 1, PSM 3 and **server channel 1**, data
  flowing 3.6 s after dialling. iOS reaches the same channel we do; it simply is
  not subject to the macOS bug, and it dials automatically ~1.2 s after the
  pedal powers on, with no app running.

**So the remedy is timing, not pairing.** `tools/macos-bt-probe/iap-spike --race`
retries at 400 ms for three minutes; power-cycle the pedal while it runs.

### A full native session, start to finish **[V]**

Measured 2026-10-07 by `iap-spike --race`. Channel to open data session in
**1.8 s**, over IOBluetooth, on macOS — the thing the browser never managed:

```text
48.688  channel 1 OPEN (mtu 503)
48.721  RX 0x38 StartIDPS            -> TX 0x02 ack
48.763  RX 0x39 FID tokens           -> "MS-100BT", "ZOOM", jp.co.zoom.p1 @ index 1
48.763  TX 0x3a token ACKs
48.806  RX 0x3b EndIDPS status=0     -> TX 0x3c      IDENTIFICATION ACCEPTED
48.806  TX 0x14 request certificate
49.215  RX 0x15 section 0/1          -> TX 0x02 ack
49.255  RX 0x15 section 1/1                          908 bytes, 2 sections
49.255  TX 0x16, TX 0x17             20-byte challenge
50.429  RX 0x18 signature (128 B)    -> TX 0x19 accept
50.429  TX 0x3f open jp.co.zoom.p1
50.463  RX 0x41 00 3f                                DATA SESSION OPEN
51.077  TX 0x40                                      session closed cleanly
```

**Authentication is a precondition for the data session, not an optional
courtesy. [V]** An earlier run sent `0x3F` immediately after `EndIDPS` and got
**no answer at all** — no rejection, just silence, which reads exactly like a
dead pedal. With the certificate exchange and challenge in between, the pedal
answers `0x41` in **34 ms**. `app/iap.js` already sequences it this way; this
records *why* that order is required. See `protocol.md` 3.3.

The spike accepts the signature without verifying it, because it is a
reachability probe. A real client must verify — `app/iap-signature.js` does.

### Three dead ends, measured so nobody repeats them **[V]**

All three are plausible, all three are wrong, and each cost an evening's worth
of reasoning on 2026-10-07.

**1. `connect` is not an "accessory appeared" signal.** Chrome 130+ fires
`connect` on `navigator.serial` for RFCOMM ports, which looks like the trigger a
page needs to open at the right moment. It is not. Per Chrome's own definition a
port is logically connected "if the device hosting the port has any open
connections to the host" -- so the event fires *after* something has connected
the device, not when it powers on. Measured both ways: with a blind `open()`
loop running, four `connect` events fired (our own opens caused them); with only
a passive listener and nothing dialling, the pedal was power-cycled and **no
event fired at all**. The trigger is circular, and there is no other: Chrome's
documentation states that "if the system doesn't know, something has to actually
try to connect to find out if the device is there."

Nor can a page ask the OS to connect. The whole `SerialPort` surface is `open`,
`close`, `getInfo`, `getSignals`, `setSignals`, `forget`, with `connected`
read-only. `open()` is the only lever, and a failed one costs 10,004 ms -- four
attempts per forty seconds against the ~450 the native probe needs.

**2. Holding the baseband link does not help.** Tempting, because one Chrome
`open()` did once succeed in 91 ms with a link already up -- which suggested a
~20-line helper could keep the link alive and leave the web app otherwise
untouched. `bt-hold` does exactly that (openConnection(), no RFCOMM channel, so
the pedal's one channel stays free). With it running and both ports reporting
`connected: true`, Chrome still timed out at **10,004-10,011 ms on every
attempt**. The 91 ms success had followed `rfcomm-listen` holding an *open
RFCOMM channel*, so what Chrome attached to was a live session, not a link --
and that cannot be handed over, because it occupies the only channel.

**3. macOS ships the ExternalAccessory API without the iAP daemons.** So
`iosapp/` cannot be rebuilt for macOS, by Catalyst or otherwise.
`ExternalAccessory.framework` and the private `IAP.framework` are both present on
macOS 26.6.2, and a test program links and runs against them -- then reports:

```text
IAPDHasLaunched:  iapdAvailableState  100 -> 0
IAP2DHasLaunched: iap2dAvailableState 100 -> 0
IAPAppRegisterClient: registerWasSuccessful 0
connectedAccessories count 0
```

Neither `iapd` nor `iap2d` exists anywhere on the system, and no iAP service is
loaded in launchd. `EAAccessoryManager` therefore reports zero accessories for
**any** MFi device. **iOS implements iAP; macOS does not.** That is the whole
reason this project speaks iAP1 itself over raw RFCOMM, and why the iPad
connects in 3.6 s while the Mac cannot.

### What this means for the clients

| | |
|---|---|
| Chrome / Web Serial | **Cannot work reliably.** `open()` happens when the user presses Connect, which is always after macOS has settled on the device. No change to `app/` fixes this. |
| A native macOS app | **Works**, if it races the open on device appearance instead of connecting on demand. Everything above `transport.js` — every codec, the whole UI — is unchanged. |
| `iosapp/` | Unaffected. `ExternalAccessory` does not use this code path, which is why the iPad has worked throughout. |

### What does not work

Measured, not assumed:

- `sudo pkill bluetoothd`
- Quitting and restarting Chrome
- A full macOS restart — the state survived a reboot of both Mac and pedal
- Releasing the ACL link (unblocks *other* hosts, not the local one)
- ~~Re-pairing — worked four times, then did not~~ — **superseded 2026-10-06**:
  re-pairing is the measured remedy (above). Those earlier failures are
  unexplained and may be a different state.

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
