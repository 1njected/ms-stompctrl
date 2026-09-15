# The MS-100BT firmware

What the pedal's firmware shows about the protocol behind it. `protocol.md`
describes the wire; this describes the machine.

The question this was written to answer was **is there a command that writes a
patch?** The firmware's answer is no: a host can load the edit buffer and set a
destination slot, but the routine that commits to flash is reachable only from
the front panel. The route that does work is on the wire, not in the firmware —
see `protocol.md` §5.5.

## Method, and what it costs to get wrong

Three properties of this target decide what evidence is admissible.

**Capstone mis-decodes C64x+.** The architecture packs 16-bit *compact*
instructions inside fetch packets introduced by a header word. IDA decodes them;
capstone's `CS_ARCH_TMS320C64X` does not. A linear capstone sweep of the 427 KB
`ddr_code` yields 83,547 decoded words of which 11,872 claim to be `b` and **not
one** is a `callp`, where IDA finds `CALLP` throughout the same bytes. Call
graphs, call-site counts and "has no caller" claims built on such a sweep are
unreliable in both directions.

**Immediate scans need a control.** A 16-bit immediate field matches any small
number you go looking for, so a scan that finds your constant has proved
nothing. `tools/fw-xref-scan.py` enforces this: it refuses to report unless
its controls reproduce a known answer first. Treat an uncontrolled
immediate-scan hit as a lead, never a finding.

**An empty IDA xref means "not found", not "does not exist".** C64x
materialises a data address from an `MVK`/`MVKH` immediate pair, which IDA does
not turn into a data xref. `xrefs_to` on every SysEx template address returns
nothing, though ten builders demonstrably reference them.

## Loading the image

`tools/ida-load-ms100bt.py` places the sections and names the sites below.
The processor must be **TMS320C6** — not MetaPC, which is x86 — and is fixed at
load time. `add_segm` leaves permissions clear, and IDA will not analyse a
segment it does not consider executable, so without setting them the database
comes up with the right sections, the right processor and zero functions. There
is no Hex-Rays decompiler for C6000; disassembly only.

The container is a plain section table: `YSX`, a 4-byte load address, a 4-byte
length, the data, then one trailing byte. Ten sections cover 99% of the file and
end seven bytes from EOF.

| file offset | load address | length | |
|---|---|---|---|
| `0x000054` | `0x11817000` | `0x2ec0` | internal RAM, fast code |
| `0x002f20` | `0x11819ec0` | `0x1480` | internal RAM |
| `0x0043ac` | `0x1181c340` | `0x0480` | internal RAM |
| `0x004838` | `0xc00e1630` | `0x0010` | external DDR |
| `0x004854` | `0xc00e1640` | `0x68460` | external DDR — the main 427 KB of code |
| `0x06ccc0` | `0xc0149aa0` | `0x9da4` | external DDR |
| `0x076a70` | `0xc015d2ec` | `0x0e34` | external DDR |
| `0x0778b0` | `0xc015e120` | `0x02a0` | external DDR |
| `0x077b5c` | `0xc015e400` | `0x0200` | external DDR |
| `0x077d68` | `0xc015efd0` | `0x14e4` | external DDR |

Auto-analysis being unavailable, `define_func` was driven by hand, seeded at each
gap boundary and iterated — a function's end is usually the next function's
start, so the walk is self-correcting. That took `ddr_code` from 50.8% to 95.0%
defined, about 98 functions to about 380. Two regions refuse definition
(`0xc00e2074`–`0xc00e2904`, `0xc00f394c`–`0xc00f4558`) and are probably embedded
jump tables.

## Transmitting SysEx

A table of literal `f0 52 …` byte templates lives at `0xc01531e0` in a data
section. Pairing `mvk`/`mvklh` instructions reconstructs the 32-bit constants
the code builds; 4,598 such pairs yield 1,854 distinct constants, and every
template has exactly one referencing site.

| template | command | built at |
|---|---|---|
| `0xc0153478` | `00` | `0xc00f9198` |
| `0xc0153498` | `04` | `0xc00faca8` |
| `0xc01534a8` | `05` | `0xc00facec` |
| `0xc0153388` | `06` | `0xc00f9d58` |
| `0xc0153358` | `17` | `0xc00f9fc0` |
| `0xc0153480` | `20` | `0xc00fabec` |
| `0xc0153488` | `21` | `0xc00fac54` |
| `0xc0153398` | `31` | `0xc00fad34` |
| `0xc01531e0` | `32` | `0xc00fadc8` |
| `0xc01533e8` | `60` | `0xc010af80` |

Six sit inside 476 bytes, so that window is the SysEx frame builder.

`0xc00f8d64` is the transmit routine. Both the `0x32` builder and the `0x60`
builder end in a call to it, and the frame the `0x60` builder produces —
`f0 52 00 <model> 60 05 00 f7` — is observed on the wire as the pedal's reply to
`60 06`, `60 07` and `60 01`.

The `0x32` builder's true entry is `0xc00fada4`, called from `0xc00fb2c0` and
`0xc0121620`. It copies the fifteen-byte template, fills the device byte from a
global at `*B14(0x134)`, and writes four 7-bit parameters at offsets 5 to 8 —
`32 01 00 00 <slot>`, with `extu …, 0x19, 0x19` masking confirming 7-bit MIDI
values. `0xc0121620` loads the patch number from `B14+0x468` and bound-checks it
against 50, so the frame is parameterised by the currently selected patch.

**`0x32` is the pedal announcing that a store happened, not a command that causes
one.** A conditional skip on `*B14(0x284)` reads as a notifications gate.

## Receiving SysEx

`sub_C00F9708` is the command table. It stores the received command byte at
`0xc009fa28` and maps it to an internal request code in `*B14(0x130)`, which
`sub_C00FA1FC` dispatches to build a reply.

| received | request code | |
|---|---|---|
| `0x00`–`0x07` | jump table at `0xc015d758` | |
| `0x08`, `0x09` | — | accepted; the patch dump is built elsewhere |
| `0x16` | 10 | |
| `0x28` | — | accepted |
| `0x29` | 12 | accepted |
| `0x2B` | 14 | |
| `0x31`, `0x32` | — | accepted |
| `0x33` | 20 | |
| `0x50` | 11 | **sets** `*B14(0x284)` |
| `0x51` | 21 | **clears** `*B14(0x284)` |
| `0x60` | `0x1B` | filesystem |
| `0x61` | `0x1C` | audio |

**`*B14(0x284)` is an editor-mode gate.** `sub_C00FA1FC` opens by testing it and,
when set, emits `240`, `82`, `0`, the model byte, then `40` — that is `0x28` —
then 122 payload bytes, then `0xF7`. 122 is exactly the patch length `backup.js`
validates in the `08` reply. `build_sysex_32` reads the same flag.

This is why `F0 52 00 5E 29 F7` draws no reply on its own: editor mode has to be
enabled with `0x50` first.

### The second pass

`sub_C00F9708` runs twice. Pass 1 classifies the command byte; pass 2 feeds the
payload one byte at a time through a table at `0xc015d72c` covering commands
40–50.

| command | payload handler | |
|---|---|---|
| `0x28` | `loc_C00F9020` | the edit-buffer write |
| `0x2A` | `sub_C00F8FBC` | |
| `0x31` | `sub_C00F8EF0` | parameter edit |
| `0x32` | `loc_C00F8EA0` | store request |

`loc_C00F8EA0` masks each byte to 7 bits into a buffer at `0xc009ea0f` indexed by
position, and on **reaching index 8** sets request code 19:

```text
CMPEQ  8, B1, B0          ; index == 8 ?
[!B0]  BNOP done
MVK    0x13, B0
STW    B0, *B14(130h)     ; request code 19
```

Request 19 reads the accumulated buffer at `0xc009ea10`, dispatches on a
sub-selector that must be 1, 2 or 3, bounds a field against 50, and writes
another field to `*B14(0x27C)` — the store destination slot.

So a received `0x32` does set state, and the trigger is reaching payload index 8.
The pedal's outbound notification and its inbound store request are different
shapes: the outbound frame carries nine payload bytes and never reaches index 8.

## Why the firmware has no host-driven store

`sub_C00FB24C` performs the store. It has four callers, all in the front-panel
cluster: `0xc00f0500` in `sub_C00F034C`, `0xc00f0ba0` and `0xc00f0d24` in the key
dispatcher `sub_C00F09F4`, and one tail call to itself. **Nothing in the SysEx
receive path calls it.**

| | |
|---|---|
| Host, over SysEx | load the edit buffer (`0x28`), set the destination slot (`0x32` → request 19 → `*B14(0x27C)`) |
| Front panel only | commit — `sub_C00FB24C` is reachable only from the key dispatcher |

Confirmed against hardware: 24 `0x32` frames sweeping payload base offset 0–6
against sub-selectors 1 and 2, with every filler byte set to the index of a
sacrificial slot so any store could only land there. Nothing stored; that slot's
CRC never moved, and a full re-read of all fifty found no collateral change.

`sub_C00F09F4` is the key/encoder handler — `0x770` bytes, 337 basic blocks,
accepting events `0x20`, `0x21`, `0x22`, `0x41`–`0x4A` (jump table at
`0xc015dd54`), `0xA0`, `0xA1`, `0xA2`, `0xE0`, `0xE3`. Those are internal UI
events, not wire bytes: `0xA0`, `0xE0` and `0xE3` are above `0x7F`, and a SysEx
data byte never is. It is why pressing STORE on the pedal reaches patch memory,
and no SysEx handler posts into it.

`AUTO SAVE` at `0xc014f3fd` sits inside the system-settings string table —
`TUNER\0POWER MANAGEMENT\0AUTO SAVE\0BATTERY TYPE\0LCD B…` — a front-panel
preference with no command in the receive table that touches it.

**The firmware therefore offers no host-reachable commit.** What makes writing
work in practice is that leaving a patch commits the edit buffer when AUTO SAVE
is on, which is a front-panel behaviour a host can trigger with a MIDI Program
Change. `protocol.md` §5.5 has the sequence.

## Patch memory as the firmware holds it

`0xc0121294` and `0xc012141c` handle the patch structure, and it matches
`protocol.md` §7.3 exactly: six effect slots, eleven parameters each, then an
eleven-byte name field at offset 108 of a 122-byte record. The current patch
number is a global at `B14 + 0x468`.

## Other located sites

| | |
|---|---|
| SysEx transmit routine | `0xc00f8d64` |
| CRC-32 table (reflected, `0xEDB88320`) | `0xc014ecf0`, referenced from `0xc00f8d48` |
| Shared SysEx TX buffer | `0xc00d3278` |
| Display routine (`MEMORY STORE`, `Store to`, `PRESET : %s`) | `0xc00f1164` |
| Bluetooth menu strings (`PAIRING`, BD address format) | `0x72671` in the image |
