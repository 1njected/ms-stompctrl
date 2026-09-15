# Notice

## Not affiliated with ZOOM

MS StompCtrl is an independent, unofficial project. It is not affiliated with,
endorsed by, or supported by ZOOM Corporation. "ZOOM" and "MS-100BT" are used
only to say which hardware this talks to. StompShare is ZOOM's application; this
is a clean-room replacement for it, not a copy or a derivative of it.

Use it on hardware you own, at your own risk. It writes to the pedal's flash
memory. Take a backup first.

## What this repository deliberately does not contain

None of the following is redistributable, and none of it is here:

- **ZOOM firmware.** No firmware image, and no part of one.
- **ZOOM effect binaries.** No `.ZDL` files. The app installs effects from
  files you supply; `app/download-effects.py` fetches them from ZOOM's own
  public archive, which is where they should come from.
- **ZOOM's iOS application.** No part of StompShare, extracted or otherwise.
- **Effect artwork.** The app renders effect images if you place them locally;
  none are bundled.
- **The pedal's Apple authentication certificate**, captured during protocol
  analysis.
- **Compiled Frida binaries and the captures they produced.** The instrumentation
  *scripts* are in `tools/frida/` — they are this project's own code — but the
  Frida server and agent are third-party builds of tens of megabytes, and the
  install capture contains a complete ZOOM `.ZDL`. `build-compat.py` rebuilds
  the server from Frida's own published `.deb`. The read-only query capture that
  is included was checked and carries no effect binary: 466 frames, largest
  payload 27 bytes.
- **The author's own pedal contents and personal data.**

`app/effect-names.json` is a factual index — effect identifiers and the display
names the pedal itself shows. It contains no code. They exist so the editor can say
"TAPEECHO" instead of `08000090`, which is interoperability, not republication.

The index is not optional. A patch names its effects by 28-bit id, and the
pedal cannot name them: its file list covers only *installed* `.ZDL` files,
while the factory effects are built into the firmware and have no files at all.
Of the 68 effect ids the 50 factory patches use, exactly **3** appear as files
on the pedal. Without this index the editor would show hex for the other 65.

`tools/build-effect-names.py` derives the index by reading the id at `.ZDL`
offset `0x40`. Run against an FX archive fetched by `download-effects.py` it
reproduces the catalog-derived names from that archive's own index; the built-in
names come from ZOOM's StompShare bundle, so reproducing those needs a copy of
that app, which is not distributed here.

Device identifiers in these files are placeholders. The Bluetooth address
`AA:BB:CC:DD:EE:FF` in `tools/` is not a real device; set `MS100BT_ADDR` or edit
it to match your pedal.

## Scope of the MIT licence

The MIT licence covers the code and documentation written for this project.

It does not, and cannot, grant rights in the effect **names** indexed in
`app/effect-names.json`, which are ZOOM's. Those are reproduced as an index for
identification only.

## Third-party references

No third-party code is vendored here. Two works were used as references:

- **[oandrew/ipod](https://github.com/oandrew/ipod)** (MIT) — iAP1 command
  definitions and framing. `app/iap.js` is an independent JavaScript
  implementation written from those protocol definitions; no code was copied
  from it, and it is a different language. The MIT notice is mentioned in the
  source header so the reference is traceable, not because code was taken.
- **Apple's *iPod Accessory Protocol Interface Specification* R38** (2009) —
  used to audit conformance, in `docs/iap-audit.md`. That document is Apple's;
  it is described and cited, never reproduced.

## Trademarks

"ZOOM", "MS-100BT" and "StompShare" are ZOOM Corporation's. Effect names shown
by the pedal may include or allude to marks belonging to other companies; where
they do, those marks belong to their respective owners. All such names are used
here only to identify the effect a given identifier refers to.

## Protocol documentation

The protocol notes describe observations of a device the author owns,
interoperating with it. They are published so the pedal outlives its
discontinued companion app.
