# The browser client

A static page that talks to the MS-100BT over Bluetooth. There is no backend:
the HTTP server only serves files, and the browser makes the connection.

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory browser-probe
```

Desktop Chrome only — it is the only browser implementing Web Serial over
Bluetooth RFCOMM. A secure context is required, which `localhost` and HTTPS both
satisfy.

## Connecting

Pair the pedal in the operating system first; a page cannot pair a device. Then
press **Connect pedal** and choose the entry whose service UUID is
`00000000-deca-fade-deca-deafdecacaff` (RFCOMM channel 1). The pedal advertises a
second, plain serial service on channel 2 that never answers.

Everything after the port opens is automatic, and all of it is
accessory-initiated — the host never speaks first:

| | |
|---|---|
| `iap.js` | iAP1 identification. Recognises StartIDPS (`55 04 00 38 00 01 C3`), validates checksums, reassembles fragmented and combined packets, preserves transaction ids, answers transport-size and lingo-version queries, parses and acknowledges FID tokens, handles EndIDPS, then opens a data session on the advertised `jp.co.zoom.p1` protocol. |
| `iap-auth.js` | Captures the accessory's segmented PKCS#7 certificate (908 bytes on this pedal). |
| `iap-signature.js` | Issues a fresh 20-byte random challenge and verifies the RSA/SHA-1 signature against the certificate's public key. |

Signature verification proves possession of the received certificate's key. It
does **not** validate Apple CA trust or certificate expiry, and the client says
so rather than implying more.

Protocol references: [oandrew/ipod command definitions](https://github.com/oandrew/ipod/tree/master/lingo-general)
and [framing](https://github.com/oandrew/ipod/blob/master/packet.go). The
JavaScript is independently implemented from those protocol definitions.

Verified on hardware: identification, certificate capture, signature
verification and data session all complete, and the pedal reports firmware 1.30.

See `bluetooth.md` when a connection fails — most failures are the link, not the
app.

## Reading patches

**Sync from pedal** reads all 50 saved slots. The JSON holds patch names, the
original SysEx, the unpacked patch bytes and validated CRCs. Failed reads retry;
an interrupted run resumes with **Resume sync from pedal**, and a partial
download is labelled PARTIAL with `complete:false`.

This reads saved memories only. It does not switch patches, and it does not
capture unsaved edits or global settings.

The last sync is held in `localStorage` under `stomp.patchBackup.v1` and reloaded
at startup, so the patch list, the editor and the restore planner all work with
no pedal attached. It is written after every slot, so an interrupted sync
survives a reload. Every storage access is guarded and a malformed entry is
discarded rather than thrown — storage can be full, disabled by policy, or throw
outright in a private window, and none of that may stop the page loading.
`patchBackup.forget()` clears it.

## The patches page

1. **Load your patches** — a slim bar, because reading is a prerequisite rather
   than a destination. Editing, restoring and the effect picker all need it.
2. **Your patches** — the library. Each card shows its chain as short family
   labels (`DYNAMICS › EQ › DRIVE › DELAY`) with bypassed slots struck through,
   so it is scannable without opening anything. Click a card to edit.
3. **Backup & transfer** — keep a copy, bring it back.

## The patch editor

The panel offers edits that are safe by construction: they only move or flip
bytes the pedal itself wrote, so they cannot build a slot the firmware has not
seen.

| Edit | |
|---|---|
| Rename | 10 characters, clamped and ASCII-filtered |
| Bypass | per slot; flips exactly one bit of the slot word |
| Reorder | moves whole slots, so each effect keeps its own parameters |
| Clear | empties a slot |
| Swap effect | offered only for effects the loaded patches already use |

A slot row is a position, the effect's name, and beneath it the family and a
bypass marker when they apply:

```text
1   ZNR                    ▾ ZNR        On   ↑ ↓  Clear
    DYNAMICS

2   STDELAY                ▾ STDELAY    Off  ↑ ↓  Clear
    DELAY  BYPASSED

4   Empty                               ↑ ↓
```

No effect ids appear anywhere in the panel, in titles or tooltips. The name is
on its own line so names align in a column down the chain; a badge in front of
each one pushed them all to different offsets.

Swapping is the one edit that could produce something the pedal has not seen,
because a slot's 14 parameter bytes belong to whichever effect held it.
`setEffect()` refuses to invent them. The picker is nonetheless **one list of
every effect this pedal can play**, grouped by family, each option the effect's
name and nothing else — because there are two places to get the bytes:

- **A loaded patch**, where the pedal wrote them itself. 68 on a factory pedal.
- **The effect's own defaults.** Every `.ZDL` states a default per parameter, and
  `patch-params.js` packs them into the 14 bytes using the published parameter
  layout (`docs/protocol.md` §7.3). That reaches the other 149, including an
  add-on you installed but no patch uses — the case that made an effect missing
  from its own pedal's editor. For an add-on the defaults are read out of the
  stored file by `zdl.js` `descriptor()`, so an effect ZOOM publishes tomorrow
  works the moment you import it; for a firmware effect there is no file to
  read, so those 100 come from `effect-params.json`, built by
  `tools/build-effect-params.py`.

A patch wins where there is one. Which of the two a given option came from is an
implementation detail and does not reach the list: an earlier version grouped
the options by it, which only raised the question of what the grouping meant.

What the list leaves out is effects the pedal could not resolve, since it empties
such a slot silently rather than refusing the write. So: firmware effects, on
every MS-100BT, and add-ons in the browser library, which the slot's own Install
button can put on the pedal. That is the Effects page's list plus the built-ins,
which are not files and so appear on no page.

### Names

A patch names its effects by 28-bit id, and the pedal cannot name them: its file
list covers *installed* effects, while the factory effects are built into the
firmware with no files at all. Of the 68 ids the 50 factory patches use, 3 exist
as files on the pedal.

`effect-names.json` closes that gap — the 101 firmware names, about 5.9 KB
including two id lists, shipped with the app. It is an index, not binaries, and
`tools/build-effect-names.py` derives it by reading the effect id at `.ZDL`
offset `0x40`. Leading underscores are stripped; they mark bass and acoustic
effects, which the family already says in words.

**Names are firmware-only, deliberately.** An add-on's name is its filename, and
the browser holds the file — so the library already answers it, the Effects page
already shows it, and naming add-ons here as well duplicated that and went stale
whenever ZOOM published one. What the index keeps for add-ons is their *ids*, as
a bare list, because two membership questions have no other local answer and
both decide what the editor tells you about a slot:

- `factory`, the 101 firmware ids. On every MS-100BT, so such a slot survives
  any write.
- `addons`, the 117 catalog ids. One of these outside your library is *not in
  your library*, which importing fixes. An id in **neither** list is not an
  MS-100BT effect at all, which nothing fixes — and the id cannot tell those
  apart on its own: `08004030` reads as a perfectly ordinary Delay id and
  belongs to no effect.

### Patch files

The editor's **Download** and **Import…** move one patch at a time, which is
what sharing a sound needs; a whole-backup JSON is the restore panel's job.

Download writes the 146-byte edit-buffer frame — `F0 52 00 5E 28 <140 packed>
F7`, byte for byte what a write sends — as lowercase hex text with no
separators, named after the patch (`LostDlys2W.100bt`). Writing the frame rather
than the bare 122-byte body keeps the model byte in the file, which is the only
thing in a patch that records which pedal it is for. The extension mirrors the
convention of the sym.bios.is patch library, whose MS-70CDR patches are hex text
named `.70cdr`.

Import accepts five shapes, because files arrive in whatever form their author
had: hex text with or without separators, a binary `.syx`, a bare 122-byte body,
the `0x08` slot dump a backup records (checksum verified), and a one-patch
backup JSON. A whole backup is refused with a pointer to **Bring it back**.
An imported patch lands in the editor rather than on the pedal, so its chain is
on screen before **Write to pedal** is pressed; that also keeps one verified
write path rather than adding a second.

**Importing another MS model.** The family shares this envelope and this
122-byte layout, so a sibling model's file decodes cleanly, and the model byte
is reported rather than trusted — the write rewrites it. Measured on one real
import, `LostDlys2W.70cdr`: model byte `0x61`, chain FLTRDLY, DRIVE ECHO, DELAY,
ROOM, and it re-exports to a `.100bt` file differing in those two hex digits and
nothing else.

**What actually blocks a patch is the effects, per slot.** A patch carries only
ids, and an id is either a firmware effect — which ships on every MS-100BT — or
an add-on, which needs its `.ZDL` installed. The pedal does not refuse one it
cannot resolve: it commits the patch and silently empties that slot
(`protocol.md` §5.5). So the editor classifies every slot before a write:

| Slot | | |
|---|---|---|
| built-in | firmware, so on every MS-100BT | — |
| installed | an add-on whose `.ZDL` is on the pedal | — |
| not installed | an add-on the browser library holds | **Install** on the slot |
| not in your library | a catalog add-on this browser does not hold | import the FX archive |
| not an MS-100BT effect | in no MS-100BT source at all | nothing helps |
| unchecked | no pedal scan, or no library, for that slot | said out loud, not passed |

**The index records which ids are firmware.** `effect-names.json` gained a
`factory` list: the 101 ids from `InitialStomps`. It matters because the two
sources it is built from are disjoint and together are the whole index — 101
firmware plus 117 catalog is all 218 ids — so an id is firmware or an add-on
with no guessing. Without it the only available rule was "absent from the add-on
catalog, therefore firmware" (`soundPackage.plan()`'s rule for restores), which
cannot tell a firmware effect from an add-on the user never imported, and calls
the second one present. That rule is still the fallback when an index has no
`factory` field. `build-effect-names.py` omits the field rather than writing an
empty one when `StompShare.app` was not passed, because an empty list would
claim every effect is an add-on.

The split also makes the check work with nothing connected: a firmware-only
patch is answered with no pedal scan and no library at all. Only add-on slots
need those, and only those go `unchecked` without them.

**Installing from the slot.** A `not installed` slot carries an Install button.
`effectStore.catalog()` is built from the stored binaries, so a library entry is
a guarantee that the bytes are there — which is why the button is offered for
exactly that state and not for `not in your library`, where there would be
nothing to send. It calls `pedalInstaller.install()`, which takes the pedal lock
itself and so cannot overlap a write, then tells `ui.js` through
`__effectInstalled()` so the Effects page and the badge agree. The badge clears
on the next render.

That is the `LostDlys2W` case end to end: three firmware effects, and DRIVE ECHO
is `08000100` — `DRV_ECHO.ZDL`, an add-on. Uninstalled, slot 2 is badged and the
footer keeps saying so; press Install and the patch writes clean.

Codec in `../app/patch-file.js`, tests in `patch-file.test.cjs`: five input
shapes onto the same 122 bytes, slot dumps, backup JSON, a sibling-model file,
15 refusals and the filename rules.

### Writing

**AUTO SAVE must be on** in the pedal's system menu. The write works by loading
the edit buffer and then leaving the patch, and AUTO SAVE is what commits that —
see `protocol.md` §5.5 for the sequence and `firmware.md` for why no command can
commit directly.

No command can read that setting, so every write is verified by reading the slot
back and comparing name and chain. Three derived bytes never survive the round
trip; they are reported rather than hidden.

A failed verify says which kind of failure it was, because the two have nothing
to do with each other. A stale name means nothing took — the AUTO SAVE symptom.
A name that took with one slot emptied means the pedal could not resolve that
slot's effect, so the message names the effect and points at the Effects page;
asking about AUTO SAVE there sends the diagnosis in the wrong direction, which is
how it read the first time it happened.

Verified on hardware: a rename, a bypass and an effect swap applied together in
one write, each confirmed by reading the slot back.

Codec in `../app/patch-editor.js`, panel in `patch-editor-ui.js`, tests
in `patch-editor.test.cjs`, which round-trips all 50 real patches byte for byte.

## Restoring

A backup is just the patches. Every effect a patch names is either **factory** —
shipped on every MS-100BT, so already present — or an **add-on**, which is in
this browser's effect library. Measured against a real backup: of the 68 effects
the 50 factory patches reference, 65 are factory and 3 are catalog add-ons, and
none is missing from those two sources.

On restore the app reads the JSON, works out which effect ids the patches name,
and sorts them:

| | |
|---|---|
| in the library, on the pedal | nothing to do |
| in the library, not on the pedal | installed, from local storage |
| not in the library | a factory effect — present on every pedal, no action |

That last row matters: the library is the add-on catalog, so a factory effect is
absent from it by design. Treating "not in the catalog" as missing would flag 65
of 68 effects as unavailable — the ones most certain to be there.

A backup is usually opened to put *one* patch back, so the card lists the
package's patches with a checkbox each and All/None. The selection drives
everything: the plan is computed for the chosen patches alone, effects are
installed only when a chosen patch needs one, and the button says what it will do.

Effects are installed first and patches second, deliberately: a patch whose
effects are absent loads wrong. A failed effect holds back only the patches that
name it, and the summary says how many were held back and why, so a re-run has
less to do. An unset AUTO SAVE stops the run on the first slot rather than
writing nothing fifty times.

Packages that carry effect binaries still restore; their bytes are preferred when
present.

## Effects

The effects page lists the catalog and marks what is already on the pedal.
`download-effects.py`, offered from that page, fetches the catalog and artwork
from ZOOM's public archive and builds an FX archive; importing it stores
everything in this browser only. **Reload from pedal** enumerates what is
installed and reads the free space.

## Tests

Plain Node, no dependencies:

```sh
cd app && for t in *.test.cjs; do node "$t" || break; done
```

Tests that need captured hardware fixtures skip themselves when the fixtures are
absent.

## Reconnecting

Use **Disconnect** before closing or reloading the tab. Closing the port does not
end the pedal's iAP data session, and nothing async is guaranteed to finish once
a page is unloading, so a reload mid-session can leave the channel unavailable
for a few seconds. If Connect fails, wait about ten seconds and try again rather
than re-pairing — `protocol.md` §2 has the measurements, and `bluetooth.md`
covers the harder failures.
