# ZOOM MS-100BT — protocol reference

*Reference for **MS StompCtrl**, an unofficial browser client. Not affiliated with ZOOM Corporation.*

What the pedal speaks, as far as it has been established by reverse engineering. This is the
reference document: the layers, the commands, the encodings, the file formats, and the traps.

- `firmware.md` is what the pedal's own code shows about the machine behind this wire.
- `iap-audit.md` audits the client's iAP implementation against Apple's specification.
- `bluetooth.md` covers connecting, and what to do when it fails.

This file is what you would want if you had to reimplement the client from scratch.

**Status markers.** Everything below is marked:
**[V]** verified on hardware or byte-matched against a capture · **[O]** observed but not fully
understood · **[I]** inferred, never confirmed.

---

## 1. The stack

```
  application    ZOOM SysEx  F0 52 00 5E … F7      filesystem, patches, audio
  session        iAP1 data session, protocol jp.co.zoom.p1
  framing        iAP1 packets  55 <len> <lingo> <cmd> <transaction> <payload> <cksum>
  transport      Bluetooth Classic RFCOMM, channel 1
```

Every application byte travels as the payload of an iAP `0x43 iPodDataTransfer` (host → pedal) or
`0x42 DevDataTransfer` (pedal → host), each carrying a 2-byte session ID ahead of the SysEx.

The host plays the part of an **iPod**; the pedal is the **accessory**. That direction matters
throughout: the pedal authenticates itself to us, not the other way round.

---

## 2. Transport

The pedal publishes two RFCOMM services. **[V]**

| Service | UUID | Channel |
|---|---|---|
| Apple accessory (iAP) | `00000000-deca-fade-deca-deafdecacaff` | 1 |
| Serial Port Profile | `00001101-0000-1000-8000-00805f9b34fb` | 2 |

Everything in this document runs over **channel 1**. The SPP record on channel 2 opens in ~90 ms and
has never been probed; what it speaks is unknown. **[O]**

The device must be paired at the OS level first. In a browser the port is obtained with
`navigator.serial.requestPort({allowedBluetoothServiceClassIds:[…]})`, which needs Chrome 117+ on a
desktop platform.

### Transport traps

**The RFCOMM channel needs a gap between sessions. [V]** Reopening the same iAP
port:

| When | Result |
|---|---|
| immediately after a close | **fails in 10,004 ms** — an SDP timeout |
| 3 s later | opens in **59 ms** |
| 8 s after that | opens in **701 ms** |

A failed open is therefore "too soon", not a broken link. Chrome on macOS fails
the `open()` following a successful `close()` deterministically, at the
10-second SDP timeout in `bluetooth_socket_mac.mm`; the next attempt succeeds in
~700 ms. Measured over ten cycles without exception. The client backs off 2 s and
4 s between attempts rather than retrying immediately, which only bought another
ten-second timeout.

**The pedal serves one iAP host at a time. [V]** Whoever holds the Bluetooth link
locks out everyone else, including a host that cannot use it — measured: an iPad
could not pair at all while a Mac held a link it could not get RFCOMM over, and
releasing that link let the iPad connect immediately.

**The pedal does not speak on channel 2. [V]** Probed cold, and with an iAP
identify, a universal SysEx identity and `60 05`: silence to all four, 0 bytes.
The node opens and accepts writes, but nothing answers. Channel 1 carries iAP,
while macOS pins its `PersistentPorts` binding in
`/Library/Preferences/com.apple.Bluetooth.plist` to channel 2 and exposes it as
`/dev/cu.ZOOMMS-100BT`. There is therefore **no route to the pedal outside
Chrome** — the legacy node is a diagnostic, not a transport.

**Closing the port does not end the pedal's iAP data session.**
`iapHost.closeSession()` sends the `0x40` that does, and `closePort()` calls it.
Nothing async is guaranteed to complete while a page is unloading, so use
Disconnect before closing or reloading the tab rather than relying on `pagehide`.

Connection failures beyond a too-soon reopen are covered in `bluetooth.md`,
which is written from measured results and lists what does and does not clear
each state.
---

## 3. iAP1

Reference: *iPod Accessory Protocol Interface Specification* R38 (Apple, 2009). Our conformance is
audited in `iap-audit.md`.

### 3.1 Packet framing **[V]**

```
  55 <length> <lingo> <command> <transaction hi> <transaction lo> <payload…> <checksum>
```

- `55` starts every packet.
- **Length** is one byte for payloads under 256, otherwise `00 <hi> <lo>`.
- **Length counts** lingo + command + transaction + payload — not the sync byte, the length bytes
  themselves, or the checksum.
- **Checksum** is chosen so that the bytes from the length field through the checksum sum to zero
  modulo 256.
- All traffic here is **lingo `0x00`** (General).
- Transaction IDs are mandatory under IDPS and are echoed by whichever side replies.

### 3.2 Commands used **[V]**

| ID | Name | Direction | Use |
|---|---|---|---|
| `0x02` | ACK | host → pedal | acknowledges `0x42`; carries `<status> <command acked>` |
| `0x0F`/`0x10` | Request/ReturnLingoProtocolVersion | pedal ↔ host | |
| `0x11`/`0x12` | Request/ReturnTransportMaxPayloadSize | pedal ↔ host | we answer `0x1000` |
| `0x15` | RetDevAuthenticationInfo | pedal → host | the pedal's certificate |
| `0x38` | StartIDPS | pedal → host | begins identification |
| `0x39`/`0x3A` | SetFIDTokenValues / RetFIDTokenValueACKs | pedal ↔ host | capability tokens |
| `0x3B`/`0x3C` | EndIDPS / IDPSStatus | pedal ↔ host | |
| `0x3F` | OpenDataSessionForProtocol | host → pedal | opens `jp.co.zoom.p1` |
| `0x40` | CloseDataSession | host → pedal | |
| `0x41` | DevACK | pedal → host | the pedal's receipt for our `0x43` |
| `0x42` | DevDataTransfer | pedal → host | pedal application data |
| `0x43` | iPodDataTransfer | host → pedal | our application data |

### 3.3 Bring-up sequence **[V]**

1. Pedal sends `StartIDPS`; host ACKs.
2. Pedal sends `SetFIDTokenValues`; host replies `RetFIDTokenValueACKs`, accepting each token.
3. Pedal sends `EndIDPS`; host replies `IDPSStatus` with success.
4. Host requests authentication info; pedal returns a PKCS#7 certificate in sections (908 bytes on
   this unit). Host issues a challenge; pedal returns an RSA/SHA-1 signature, which the host
   verifies against the certificate's key.
5. Host sends `OpenDataSessionForProtocol` naming the advertised `jp.co.zoom.p1` index; pedal
   answers `DevACK`. Session ID 1.

Signature verification proves possession of the certificate's private key. It does **not** validate
the Apple CA chain or expiry — this client does neither.

### 3.4 FID tokens this pedal sends **[V]**

Type 0, subtype 2 are AccessoryInfo tokens keyed by a leading `accInfoType`:

| Token | Value |
|---|---|
| name (`0x01`) | `MS-100BT` |
| firmware (`0x04`), hardware (`0x05`) | `01 00 00` |
| manufacturer (`0x06`) | `ZOOM` |
| model (`0x07`), serial-ish (`0x08`) | `000` |
| **max payload (`0x09`)** | **`0f b0` = 4,016 bytes** |

Subtype 4 advertises the protocol string `jp.co.zoom.p1`; subtype 5 carries a device identifier.

**The 4,016-byte figure is the negotiated maximum `iPodDataTransfer` payload**, counting lingo,
command, transaction, session ID and data together. Without that token the default is 1,018. The
current client acknowledges the token and ignores the value — see §9.

### 3.5 Data-session rules that matter

From the specification, and all of them observable on the wire:

- Each `0x43` **must** be answered by the accessory with a `DevACK` carrying command ID `0x43` and
  **the same transaction ID**. **[V]**
- A sender whose packet is unacknowledged after **500 ms** resends **the same packet with the same
  transaction ID**. That ID is how the receiver distinguishes a retransmission from new data. Up to
  ten retries, after which the session may be closed. **[V — the pedal's own retransmit cadence
  measures 0.48–0.55 s]**
- The accessory must not send another `DevDataTransfer` until the previous one is acknowledged or
  500 ms has passed. **[V]**
- The host answers `0x42` with a General lingo `0x02` ACK. **[V]**
- An accessory that cannot accept a packet must simply not acknowledge it. **[I here]**

---

## 4. The ZOOM SysEx envelope

```
  F0 52 00 5E <command…> F7
```

`52` is ZOOM's manufacturer ID, `00` the device ID, `5E` the MS-100BT model. **[V]**

Two command families share the envelope:

- **Filesystem and audio** — a two-byte command, `0x60 xx` or `0x61 xx`.
- **Patch memory** — a single byte at the same offset, e.g. `08`, `09`, `29`.

A generic MIDI identity request, `F0 7E 00 06 01 F7`, is also accepted inside the session and is the
cheapest liveness probe. **[V]**

---

## 5. Command reference

### 5.1 Filesystem, lingo `0x60`

Every command below was seen on the wire in at least one capture. Counts are from the two captures
in `../tools/`.

| Cmd | Name | Request | Notes |
|---|---|---|---|
| `60 00` | enter file mode | `60 00 01` | must be paired with `60 01` **[V]** |
| `60 01` | leave file mode | `60 01 01` / `60 01 00` | `01` after a write, `00` after a read-only session **[V]** |
| `60 02` | descriptor | `60 02` | answered `60 04 02` **[O]** |
| `60 03` | result | — | reply only; 5-group signed result at offsets 6–10 **[V]** |
| `60 04` | status | — | reply only; `60 04 <subcommand>` **[V]** |
| `60 05` | filesystem ack | `60 05 00` | "send the payload"; follows `60 04 02/20/29` **[V]** |
| `60 06` | acquire semaphore | `60 06` | status 0 means acquired; retry while busy **[V]** |
| `60 07` | release semaphore | `60 07` | **[V]** |
| `60 09` | flush | `60 09` | after closing a written file **[V]** |
| `60 20` | open | `60 20 <mode> 00×9 <name:12>` | mode 1 = write, 2 = read **[V]** |
| `60 21` | close | `60 21 00 00 00 00 00` | **[V]** |
| `60 22` | read | `60 22 00×5 <length:5>` | payload arrives as its own frame **[V]** |
| `60 23` | write | `60 23 00×5 <length:5> <packed data> <crc:5>` | **[V]** |
| `60 24` | delete | `60 24 <name:13, NUL-padded>` | **always exactly 20 bytes** **[V]** |
| `60 25` | find first | `60 25 00 00 <pattern:13>` | `*.*` lists everything **[V]** |
| `60 26` | find next | `60 26` | ends with result `-6` **[V]** |
| `60 27` | find close | `60 27` | **[V]** |
| `60 28` | file length | `60 28 <name:13>` | size in `60 04 28` at offset 11 **[V]** |
| `60 29` | disk info | `60 29 00` | free and total bytes; see below **[V]** |

A `60 25`/`60 26` entry reply carries the filename at bytes 15–26 and the size as five 7-bit groups
at bytes 30–34. **[V]**

**Disk space.** `60 29 00` is answered by a fixed 27-byte frame: **[V]**

```text
f0 52 00 5e 60 04 29 | 01 00 08 00 | 42 70 7c 01 00 | 08 64 14 01 00 | 00 00 00 00 00 | f7
                       four unknown   total, 5 groups  free, 5 groups   five zeros
```

Total and free are five 7-bit groups each, little-endian, at offsets 11 and 16. Decoded across 23
replies in the captures: **total 4,143,170 bytes**, constant, and free varying with what is
installed — 2,437,640 bytes at one point and 2,409,010 after an effect was written, 28,630 apart for
a 26.4 KB binary. `tools/decode-protocol.py` asserts both values against the figures StompShare
itself displayed, so the layout is confirmed against the vendor's own parse rather than being merely
self-consistent.

The four bytes at offsets 7-10 and the five zeros at 21-25 are unidentified. **[O]**

`install.js` already issues `60 29` during every install and discards the reply.

**Result codes**, from the 381 `60 03` replies in the captures: **[V]**

| Value | Meaning |
|---|---|
| `0` | success — 354 occurrences |
| `-6` (`0xFFFFFFFA`) | benign: `60 24` on a file that is absent, `60 26` with the listing exhausted — 27 occurrences |
| `-1` (`0xFFFFFFFF`) | **never produced by the native app**; seen only from our client after a failed transfer |

### 5.2 Audio, lingo `0x61`

| Cmd | Name | Notes |
|---|---|---|
| `61 05` | mute | before filesystem work; answered `00 00` **[V]** |
| `61 06` | unmute | must be paired with `61 05` **[V]** |

### 5.3 Patch memory

| Direction | Frame |
|---|---|
| request | `F0 52 00 5E 09 00 00 <slot> F7` — slot 0–49 **[V]** |
| reply | `F0 52 00 5E 08 00 00 <slot> <len:2> <packed 140 bytes> <crc:5> F7` **[V]** |

The length is two 7-bit groups (`lo + 128 × hi`) and reads 122, the unpacked size; the packed body
is therefore 140 bytes. `F0 52 00 5E 29 F7` is also used during backup. **[O]**

### 5.4 Writing patches — what each command actually does **[V]**

| Command | | |
|---|---|---|
| `0x50` | editor mode on | required before `0x28`/`0x29` answer; allow ~2.5 s |
| `0x29` | read edit buffer | 146 bytes, 122-byte body |
| `0x28` | write edit buffer | a real write, proven by an observable rename |
| `0x32` | — | **outbound only**; announces a store, never causes one |
| `0x51` | editor mode off | |

**`0x28` writes a staging buffer, not the live patch.** The bytes go in and come
back changed, and 119 of 122 survive exactly. But the front panel does not track
it: `PROBE-A` was written and read back while the pedal went on displaying
`50 Empty`. The buffer is populated *from* the current patch — it matched slot 50
in 119 of 122 bytes on first read — so pedal → buffer exists; buffer → live patch
does not follow, and this is evidence against it.

**Patch selection is MIDI Program Change, not SysEx.** The transport carries raw
MIDI as well as ZOOM SysEx:

```text
C0 <program>        program 0-49 selects patch 1-50
```

| Sent | Staging buffer afterwards |
|---|---|
| `C0 00` | patch 1, byte-for-byte exact |
| `C0 04` | patch 5, byte-for-byte exact |

So the buffer reloads on a Program Change and matches the selected patch exactly.
This is also why no SysEx command was ever found for selection: selection does not
go through SysEx at all.

**`0x32` is outbound-only.** With editor mode on, pressing STORE on the pedal
emitted exactly one frame:

```text
f0 52 00 5e 32 01 00 00 31 00 00 00 00 00 f7      0x31 = 49 = patch 50
```

Byte for byte the frame that had been sent *to* the pedal in an attempt to
trigger a store — which had done nothing. The payload layout documented for
sibling models is correct; the pedal simply does not act on it inbound. Sending
it, in 24 payload variations sweeping the base offset and sub-selector, never
stored: the target slot's CRC never moved and a full re-read of all fifty found
no collateral change. A received `0x32` does set internal state, but nothing on
the receive path commits — see `firmware.md`.

**Three derived bytes the edit buffer does not carry.** Offsets 12, 13 and 16 of
effect slot 0 read `e0 03 32` in a stored patch and `00 00 00` in the edit
buffer. Writing the stored values back and reading again returns zeros, while all
119 other bytes survive. The pedal derives these fields rather than
round-tripping them. This is native behaviour: loading a patch zeroes them, so
storing writes the zeros back, and pressing STORE changes a patch's stored bytes
whether or not a host is attached.

### 5.5 Writing patches — solved **[V]**

**There is no store command, and one is not needed.**

```text
C0 <n>                            select patch n+1  (MIDI Program Change)
F0 52 00 5E 50 F7                 editor mode on, allow ~2.5 s
F0 52 00 5E 28 <140 packed> F7    load the 122-byte body
C0 <other>                        LEAVE the patch -- this commits it
C0 <n>                            come back
```

Leaving the patch is the commit. The pedal's **AUTO SAVE** writes the edit to
flash instead of discarding it, which is precisely what that setting exists for.
Measured: slot 50 read `Empty`, a body named `AUTOSAVE1` was loaded, the patch was
left and re-entered, and slot 50 read back `AUTOSAVE1` through the independent
`0x09` path. Writing the original body back the same way restored it.

The host never issues a store. It edits, and the pedal decides to keep the edit.

**Prerequisite: AUTO SAVE must be ON** in the pedal's system menu
(`TUNER / POWER MANAGEMENT / AUTO SAVE / …`). No command reads or sets it, so
`writeSlot()` cannot check it up front — every write is read back and verified,
and an unset AUTO SAVE surfaces as a failed verify on the first slot rather than
fifty silent no-ops.

**The settle after `0x50` is not stable.** `0x29` drew no reply at 400 ms or
1200 ms and answered every time at 2000 and 3000 ms, with the `09` control
reading slots correctly throughout. Both failures look exactly like a dead
command path. `editorMode()` waits 2500 ms.

**Not byte-exact, and not at fixed offsets.** The pedal recomputes some parameter
fields when it loads a patch, and *which* fields depends on the effects in the
chain. An `Empty` patch showed three; a real patch came back with the right name
and the right chain while four other bytes had been recalculated. Writing the
same body a second time shows zero drift, because the first write settles them.

A write is therefore verified on **the name and the chain** — the effect id and
enable bit of all six slots — and byte drift is reported as a number rather than
a verdict. `PatchBackupCodec.comparePatch()` is the rule, tested against a real
patch body in `edit-buffer.test.cjs`.

`patchBackup.selectPatch(slot)`, `patchBackup.writeSlot(slot, body)` and
`soundPackage.restorePatches(pkg)` implement this.

**Danger in the same command space.** zoom-explorer records `0x5B` as a factory
reset that **wipes all user patches**, and `0x01` as firmware update mode. A
mistyped command byte here is not a failed experiment. `app/patches.js`
refuses every command outside `{28, 29, 32}` before anything is transmitted, and
`patches.test.cjs` checks all 128 command values.
---

## 6. Encodings

### 6.1 Seven-bit packing **[V]**

MIDI bytes cannot have bit 7 set, so binary payloads are packed in groups of eight: one mask byte
carrying the high bits of the following seven data bytes, most significant first.

```
  mask = Σ ((data[j] >> 7) & 1) << (6 - j)      for j = 0..6
  out  = mask, data[0] & 0x7F, … data[6] & 0x7F
```

A payload of *n* bytes becomes `n + ceil(n / 7)`.

### 6.2 Five-group integers **[V]**

Lengths and CRCs travel as five 7-bit groups, little-endian:

```
  groups[i] = (value >>> (7 * i)) & 0x7F        i = 0..4
```

**The shift must be unsigned.** With `>>`, any value with bit 31 set sign-extends and the top group
goes out as 120–127 instead of 0–15. That is 15 of the 36 write chunks in the native capture — 42%
of every file written. See §9.

### 6.3 CRC-32 **[V]**

Reflected CRC-32, polynomial `0xEDB88320`, initial value `0xFFFFFFFF`, **no final XOR**. Computed
over the unpacked bytes. Verified against 36 native write chunks and 103 effect-list entries.

---

## 7. File formats

### 7.1 `.ZDL` effect binary **[V]**

| Offset | Content |
|---|---|
| `0x04` | `SIZE` |
| `0x0C` | u32 LE — length of section A |
| `0x10` | u32 LE — length of section B |
| `0x14` | `INFO` |
| `0x40` | u32 LE — **effect ID**; the high byte is the category |
| `0x44` | version string, ASCII |
| `0x14 + A` | `\x7fELF` — the DSP image |

Total length is `0x14 + A + B`. Filenames are 8.3, uppercase, at most 12 characters including
`.ZDL`.

#### A `.ZDL` is an unsigned TI C6000 shared object **[V]**

Examined 2026-09-12. The container is trivial: a `SIZE` record, an `INFO`
record carrying `ZOOM EFFECT DLL SYSTEM VER 1.00`, the effect id and version,
then — at offset `0x4c` in most files, `0x14c` in some — a **raw ELF**.

```text
e_type    ET_DYN (3)          a dynamic shared object
e_machine 0x8c                EM_TI_C6000
SONAME    ZDL_DYN_Comp.out
sections  .text .audio(0x7800) .const(0x80000000) .fardata
          .dynsym .dynstr .dynamic .hash .rela.dyn  — real dynamic linking
          .debug_info .debug_line — shipped with debug symbols
```

So effects are **native DSP code that the pedal loads and executes**, not data.

* **Zero imported symbols.** Effects call no firmware function through the
  linker; all 28 relocations are `__TI_STATIC_BASE`-relative.
* **One global export**, `Dll_<Name>`, and it is `e_entry`. The loader calls it.
* The rest is local: an init function, an on/off handler, one edit handler per
  parameter, and the audio routine in `.audio`, which is mapped at `0x7800`.

**The descriptor ABI is legible.** `Comp`, 288 bytes in `.const`, is the
registration struct: an effect name, a pointer to init, a pointer to the audio
routine, then one ~48-byte block per parameter holding the display name, a
min/default/max triple, and a pointer to that parameter's edit handler.
Relocated pointers in the dump land exactly on `Fx_CMP_Comp_init` (`0x230`),
`Fx_DYN_Comp` (`0x7800`), `Fx_CMP_Comp_onf` (`0xf0`), `_sens_edit` (`0x44`),
`_tone_edit` (`0x0`), `_level_edit` (`0x154`), `_attack_edit` (`0x1a4`) and
`GetString_CmpAtk` (`0x2c0`).

**A leading `_` in the filename means bass or acoustic. [V]** Twenty of the 117
catalog effects carry it, and all twenty are bass or acoustic models — the bass
drives (Bass Booster, Bass OD, Bass Muff, Bass Dist 1, Bass Metal), the bass
preamps and DIs (BASS DRIVE, D.I +, Bass BB, DI5, Bass Pre, AcoBass Pre), and
the amp models, which are all bass rigs plus two acoustic ones (SVT, B-Man,
HRT3500, SMR, FlipTop, SuperB, Mark B, acoustic, Ag Amp).

The id says the same thing without the filename. **Byte 2 of the effect id is
non-zero exactly for these**, with no exceptions across all 117:

| byte 2 | count | effects |
|---|---|---|
| `0x00` | 97 | electric guitar |
| `0x40` | 5 | bass drive, category `0x01` |
| `0x60` | 6 | bass preamp / DI, category `0x01` |
| `0x10` | 9 | amp models, category `0x05` |

So `(effectId >> 16) & 0xff` distinguishes instrument families, where the top
byte is the category §7.2 uses. Together the two bytes name the effect's family,
which matters because **the id is the only identity most effects have** — the
catalog can name 3 of the 68 a factory pedal's patches use. Grouping all 117
catalog effects by the pair gave eleven internally consistent groups:

| top byte | byte 2 | family |
|---|---|---|
| `01` | `00` | Dynamics — comp, limiter, gate |
| `01` | `40` | Bass drive |
| `01` | `60` | Bass preamp / DI |
| `02` | `00` | Filter & EQ |
| `03` | `00` | Drive |
| `04` | `00` | Amp |
| `05` | `10` | Bass/acoustic amp |
| `06` | `00` | Modulation |
| `07` | `00` | Synth |
| `08` | `00` | Delay |
| `09` | `00` | Reverb |

It reads the id rather than any file, so it works for built-in effects too: all
68 used by the factory patches resolve, across 8 families.
`PatchEditor.describe()` implements it and the editor leads each slot row with
it, because "Dynamics, Drive, Delay, Reverb" reads as a signal path where
"01000008, 03000020, 08000040, 09000020" does not. None of the 68 effects the factory patches use
has a non-zero byte 2: the shipped guitar patches never reference a bass or
acoustic model.

**Nothing authenticates a `.ZDL`.** No signature field, no hash in the
container; the only integrity check is the per-chunk CRC-32 the install path
already computes, which is a transport checksum, not a signature.

**What that means for patch writing.** A custom effect is arbitrary code
execution on the pedal's DSP by design, so in principle it can do anything the
firmware can, including committing the edit buffer to a slot. It is a real
route, and it is the only one left after `0x32` turned out to be outbound-only.
It is also the most expensive and the only one that can plausibly brick the
pedal. See §10.

### 7.2 `FLST_SEQ.ZDT` — the effect list **[V]**

4,108 bytes exactly: **316 records of 13 bytes**.

| Record | Meaning |
|---|---|
| `>>> 00 <id> 00…` | start of category `<id>` |
| `<<< 00 <id> 00…` | end of category |
| `NAME.ZDL` NUL-padded | a listed effect |
| thirteen `00` | unused slot |

32 categories, IDs 0–31, in order. Installing inserts one record **immediately after its category's
start marker**, shifting the remainder down and consuming one trailing unused slot; deleting is the
exact inverse. The category is the high byte of the effect ID at ZDL offset `0x40` — a rule that
matched all 103 listed effects with no exceptions.

**The pedal will not show an effect that is on the filesystem but absent from this list.** It stays
on "Now loading" until the host enumerates the directory.

#### The 122-byte patch body, field by field **[V]**

Read off the 50 factory patches in a hardware backup, not from sibling models.

| Offset | Field |
|---|---|
| `0`–`107` | six effect slots, 18 bytes each |
| slot `+0`–`+3` | u32 LE — bit 0 **enabled**, bits 1–28 **effect id**, bits 29–31 unidentified |
| slot `+4`–`+17` | that effect's parameters |
| `108`–`110` | patch-level fields, not decoded |
| `111`–`120` | name, 10 characters, space padded |
| `121` | `0` in all 50 patches |

**Bit 0 is bypass, not part of the id.** Five effect ids appear in the factory
patches with the bit both set and clear, and eight slots ship bypassed —
`CrunchAmp` slot 1 among them. An id of 0 means an empty slot.

**Bits 29–31 are not always zero** and are carried through verbatim; an encoder
that assumes them zero corrupts real patches, which is how the first version of
`patch-editor.js` failed its round-trip test.

`app/patch-editor.js` decodes and encodes this, and
`patch-editor.test.cjs` round-trips all 50 real patches byte for byte.

**Effect ids in patches have no name available *from the pedal or the catalog*,
but the names exist. [V]** The downloadable
catalog holds 117 effects; the factory patches use 68; **only 3 are in both.**
The effects a patch references are built into the firmware rather than installed
as files, so the catalog — which is the add-on store — cannot name them.
`FLST_SEQ.ZDT` lists filenames by category but carries no effect id per record,
so it cannot bridge the two either. The names exist only in the firmware's own
effect descriptors.

The names are in ZOOM's StompShare bundle, whose `InitialStomps` directory
carries one `.ZDL` per factory effect with the id at offset `0x40`.
`tools/build-effect-names.py` extracts an id-to-name index from it —
`01000008` is `COMP`, `01000050` is `ZNR` — covering all 68 the factory patches
use. That is metadata rather than binaries, and it is what lets the editor show
effect names at all.

**Which edits are safe.** Rename, bypass, reorder and clear only move or flip
bytes the pedal itself wrote, so they cannot produce a slot the firmware has not
seen. Swapping in a *different* effect is not in that class: bytes `+4`–`+17`
belong to whichever effect the slot held, and nothing in the patch says what the
new one expects. `setEffect()` therefore requires the caller to supply all 14
parameter bytes and refuses to invent them. The defaults are obtainable — each
`.ZDL` descriptor carries a min/default/max triple per parameter (§7.1) — but
that is not wired up.

### 7.3 Patch memory **[V]**

122 unpacked bytes per slot, 50 slots. Six effect slots of 18 bytes each; the effect ID is the low
28 bits of the first little-endian word, shifted right by one. The patch name is ASCII at bytes
111–120.

---

## 8. Operation sequences

All of these run under a **single** `60 06` … `60 07` semaphore, which is what the native app does.

### Install an effect **[V]**

```
  60 06                     acquire
  61 05                     mute
  60 00 01                  enter file mode
  60 29                     disk info
  F0 7E … identity
  60 24 <name>              delete any existing copy
  F0 7E … identity
  60 02                     descriptor
  60 20 01 … <name>         open for writing
  60 23 … × ceil(size/4096) write, each chunk CRC'd
  60 21                     close
  60 09                     flush
  ── effect list ──
  F0 7E …, 60 02, read FLST_SEQ.ZDT, insert, 60 24, 60 20 01, 60 23 ×2, 60 21, 60 09
  ── finish ──
  60 25 / 60 26 … / 60 27   enumerate, which clears "Now loading"
  60 01 01                  leave file mode
  61 06                     unmute
  60 07                     release
```

### A note on what may fail an install **[V]**

Only the parts that decide whether the effect is on the pedal should be able to
fail an install. Observed 2026-09-13: `RED_CRU.ZDL` reported *"Pedal write
response timeout"*, and afterwards the binary was on the filesystem **and**
listed in `FLST_SEQ.ZDT` — the install had completed. The reported failure then
ran the abort against a pedal with nothing to abort, which left it on "Now
loading" and eventually wedged its filesystem task.

The cause was that the final `60 07`, the semaphore release, was the one
teardown step not wrapped, while `60 01 01` and `61 06` beside it both were. By
that point the file is written and listed, so the install has succeeded whatever
the semaphore does. A release that really is stuck surfaces on the next
operation, and the abort retries it.

### Abandon a failed install **[V]**

An install that fails has to leave the pedal usable, and this is easy to get
wrong: the pedal shows **"Now loading" until its directory is enumerated**, and
a half-written file is worse than none, because it sits on the filesystem absent
from `FLST_SEQ.ZDT` and §7.2 records that the pedal will not show such a file —
it stays on "Now loading" permanently.

```
  60 21                     close the open file
  60 09                     flush
  60 24 <name>              delete the partial file
  60 25 / 60 26 … / 60 27   enumerate — this is what clears the display
  60 01 01                  leave file mode
  61 06                     unmute
  60 07                     release
```

Every step is best-effort: this runs because something already failed, and one
more failure must not stop the rest. An earlier version did only `60 21`,
`60 09`, `60 07`, so every failed install left the pedal on "Now loading" and
still in file mode.

The same enumeration is what `pedalInventory.run()` does, which is why "Reload
from pedal" clears the display by hand.

### Delete an effect **[V, unit-tested; not yet run against hardware]**

The inverse, with one deliberate ordering choice: **rewrite the effect list before deleting the
file.** If the file delete then fails, the pedal holds a file it no longer lists — invisible and
reinstallable. The other order leaves the list naming a file that is gone.

### Read the directory **[V]**

`60 06`, `60 25 *.*`, `60 26` until result `-6`, `60 27`, then `60 01 01`, `61 06`, `60 07`.

### Write a patch **[V]**

No semaphore and no file mode — this path is entirely outside the `0x60`
filesystem. See §5.5 for why it is shaped this way.

```
  C0 <n>                    select patch n+1        (MIDI Program Change)
  F0 52 00 5E 50 F7         editor mode on, then wait ~1 s
  F0 52 00 5E 28 <140> F7   load the 122-byte body into the buffer
  C0 <other>                LEAVE the patch — AUTO SAVE commits it here
  C0 <n>                    come back
  F0 52 00 5E 51 F7         editor mode off
  F0 52 00 5E 09 00 00 <n> F7   read it back and verify
```

**AUTO SAVE must be on** in the pedal's system menu, and no command can read or
set it, so the read-back is the only way to know the write landed. Three derived
bytes never survive; a difference confined to them is success.

### Back up patches **[V]**

50 × `F0 52 00 5E 09 00 00 <slot> F7`, each reply CRC-checked. Reads saved memories without
switching the selected patch.

---

## 9. Findings

Things that cost real time, and the evidence for them.

**The five-group encoder must use `>>>`.** With `>>`, 42% of write chunks carried a corrupt CRC.
The pedal reports a rejected chunk in a status word, so discarding that word hides the fault
entirely.

**`60 24` is always a 20-byte frame.** The filename sits in a fixed 13-byte NUL-padded field —
`_AG_AMP.ZDL` takes two pad bytes, `FLST_SEQ.ZDT` takes one. Building the frame from the unpadded
name happened to be correct for 11-character names, the only length in the captured install, and
wrong for every other. A malformed delete fails silently.

**A retransmission must reuse its transaction ID.** That ID is how the accessory recognises a repeat
rather than new data. Retrying under a fresh ID appended a fragment the pedal had already received
to the file a second time. Reusing it coincided with the first clean run: ten consecutive installs,
no stalls.

**A missing `DevACK` may mean slow, not absent.** A reply delayed past 120 s by the pedal's flash
task is on record. Delivery tracking must therefore keep the transaction registered across attempt
windows rather than discarding it on timeout.

**Enumerating the directory is what clears "Now loading"**, not the effect-list write. The native
app enumerates while still in file mode, before `60 01`.

**Patch selection is MIDI, not SysEx.** Everything else in this document is a
ZOOM SysEx frame, and the transport carries raw MIDI too. Selecting a patch is an
ordinary two-byte Program Change. No SysEx patch-selection command exists, which
is why no search for one found anything.

**The pedal never stores on command; it stores on leaving a patch.** There is no
store command in the protocol. Writing a patch means editing the buffer and then
navigating away, and letting AUTO SAVE do what it exists to do. Every attempt to
find a store command failed for the same reason: the store executor is reachable
only from the front-panel key dispatcher, never from the SysEx receive path.

**An RFCOMM open that fails may just be too soon.** Reopening the iAP port
immediately after a close fails in ~10 s with an SDP timeout; three seconds later
it opens in 59 ms. Retrying without a pause buys another timeout. The plain SPP
port on the same pedal is the cheapest way to prove the link is healthy — if it
opens and the iAP one does not, wait rather than re-pair.

**A leading `_` on an effect filename means bass or acoustic**, and byte 2 of the
effect id says the same thing without the filename. §7.1.

**`60 24` and `60 28` are both 20-byte frames.** Length alone cannot tell them apart.

**`60 01 01` ends an install; `60 01 00` ends a read-only session.** Both appear in captures.

**The pedal answers a `60 23` chunk in either of two ways** within a single install: `60 04 23`,
after which the host sends `60 05 00` and receives `60 03`; or `60 03` directly. Accepting only the
first discards a good reply and stalls for the full timeout.

**Consecutive wire frames must fit the transport boundary.** A 3,800-byte fragment followed by a
915-byte one left the pedal holding half a packet indefinitely; it will not accept more data in that
state, so retrying cannot help.

**A repeating `0x42` at 500 ms with nothing of ours acknowledged is a transport stall**, and is
distinct from the lockup, where the pedal keeps acknowledging with `0x41` while the application
answers nothing. They look alike and need different responses: a stall clears itself, a lockup needs
a power cycle.

**Write latency drifts upward across a session.** Over ten installs `worstWriteMs` climbed
monotonically from 19.5 ms to 104.1 ms while `worstReadyMs` stayed at 0.8–2.5 ms — the host is never
flow-controlled off, but the write call itself slows as a session ages. Not currently causing
failures.

**`../tools/capture*.jsonl` holds full packet bytes** under a **top-level `hex` key**, outside the
`message` object, not only inside it.

---
