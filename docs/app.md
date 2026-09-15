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
`setEffect()` refuses to invent them, so the picker offers only effects that
appear somewhere in the loaded patches and reuses a parameter block the pedal
wrote — 68 on a factory pedal. Options are grouped by family and carry the
effect name and nothing else.

### Names

A patch names its effects by 28-bit id, and the pedal cannot name them: its file
list covers *installed* effects, while the factory effects are built into the
firmware with no files at all. Of the 68 ids the 50 factory patches use, 3 exist
as files on the pedal.

`effect-names.json` closes that gap — an id-to-name index of 218 entries, about
5.5 KB, shipped with the app. It is an index, not binaries.
`tools/build-effect-names.py` derives it by reading the effect id at `.ZDL`
offset `0x40`. Where the catalog has a display name it wins over the filename,
because it reads better: `01400010` is `Bass Booster` rather than `B_BOOST`,
`01000035` is `160 Comp` rather than `160_COMP`. The factory set keeps its
filename (`COMP`, `ZNR`, `TAPEECHO`). Leading underscores are stripped; they mark
bass and acoustic effects, which the family already says in words.

### Writing

**AUTO SAVE must be on** in the pedal's system menu. The write works by loading
the edit buffer and then leaving the patch, and AUTO SAVE is what commits that —
see `protocol.md` §5.5 for the sequence and `firmware.md` for why no command can
commit directly.

No command can read that setting, so every write is verified by reading the slot
back and comparing name and chain. Three derived bytes never survive the round
trip; they are reported rather than hidden.

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
cd browser-probe && for t in *.test.cjs; do node "$t" || break; done
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
