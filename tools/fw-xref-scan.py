"""Find callers and address-materialisations in the MS-100BT firmware.

IDA's xref graph on this image is incomplete by construction: C64x builds a
32-bit address from an MVK/MVKH immediate pair, which IDA does not turn into a
data xref, and direct calls are PC-relative so they leave no absolute address
anywhere. This script answers "who reaches address X" three ways.

EVERY ANSWER MUST BE VALIDATED. Scanning this image for small immediates has
produced four confident readings that were wrong (docs/protocol.md 5.4), so each
method here runs a control first: a known-good target whose answer is already
established, which the method has to reproduce before its result is worth
anything. `--check` runs the controls alone.

    python3 runtime/fw-xref-scan.py --check
    python3 runtime/fw-xref-scan.py 0xc00f09f4

KNOWN LIMIT: branch scanning reads 4-byte-aligned words. C64x+ packs 16-bit
compact instructions inside fetch packets, and inside those this scan can both
invent a branch and miss one. It reported a caller for sub_C00F1164 that IDA
does not have. Treat a hit as a lead and a zero as "not found", never as proof.
"""
import glob, os, struct, sys

SECTIONS = os.path.join(os.path.dirname(__file__), '..', 'firmware1.30', 'sections')

def load():
    out = []
    for f in sorted(glob.glob(os.path.join(SECTIONS, '*.bin'))):
        out.append((int(os.path.basename(f).split('_')[1], 16), open(f, 'rb').read()))
    if not out:
        sys.exit(f"No sections in {SECTIONS}. Run: python3 runtime/ida-load-ms100bt.py --split <MAIN.bin>")
    return out

def stored_pointers(secs, target):
    """The address written somewhere as a little-endian 32-bit word."""
    pat, hits = struct.pack('<I', target), []
    for base, d in secs:
        start = 0
        while (i := d.find(pat, start)) != -1:
            if i % 4 == 0: hits.append(base + i)
            start = i + 1
    return hits

def mvk_pairs(secs, target):
    """An MVK/MVKH pair materialising the address. Constant sits at bits 22-7."""
    lo, hi, hits = target & 0xFFFF, (target >> 16) & 0xFFFF, []
    for base, d in secs:
        n = len(d) // 4
        c = [(w >> 7) & 0xFFFF for w in struct.unpack('<%dI' % n, d[:n * 4])]
        his = {i for i, v in enumerate(c) if v == hi}
        for i, v in enumerate(c):
            if v == lo and any(j in his for j in range(max(0, i - 8), min(n, i + 9))):
                hits.append(base + i * 4)
    return hits

def branches(secs):
    """Direct B/CALLP targets. 21-bit displacement, relative to the fetch packet."""
    out = {}
    for base, d in secs:
        n = len(d) // 4
        for i, w in enumerate(struct.unpack('<%dI' % n, d[:n * 4])):
            if ((w >> 2) & 0x1F) != 0b00100: continue
            disp = (w >> 7) & 0x1FFFFF
            if disp >= 1 << 20: disp -= 1 << 21
            a = base + i * 4
            out.setdefault((a & 0xFFFFFFE0) + (disp << 2), []).append(a)
    return out

# (target, method, expected hit, what it is)
CONTROLS = [
    (0xc01531e0, 'mvk',    0xc00fadc8, 'build_sysex_32 materialises the 0x32 template'),
    (0xc01533e8, 'mvk',    0xc010af80, 'build_sysex_60 materialises the 0x60 template'),
    (0xc00fada4, 'branch', 0xc0121620, 'the 0x32 sender, 2 callers, matches IDA'),
    (0xc00f8d64, 'branch', 0xc010afa8, 'the transmit routine, 27 callers, matches IDA'),
]

def run_controls(secs, B):
    ok = True
    for target, method, expect, what in CONTROLS:
        got = mvk_pairs(secs, target) if method == 'mvk' else B.get(target, [])
        good = expect in got
        ok &= good
        print(f"  [{'ok ' if good else 'FAIL'}] {method:6} {target:#010x} -> {len(got):3} hits   {what}")
    return ok

def main():
    secs, args = load(), sys.argv[1:]
    B = branches(secs)
    print("controls:")
    if not run_controls(secs, B):
        sys.exit("\nA control failed: the scan is not measuring what it claims. Do not trust any result.")
    if '--check' in args or not args:
        return
    for a in args:
        t = int(a, 16)
        print(f"\n{t:#010x}")
        for label, hits in (("stored pointer", stored_pointers(secs, t)),
                            ("mvk/mvkh pair", mvk_pairs(secs, t)),
                            ("direct branch", B.get(t, []))):
            print(f"  {label:15} {len(hits):3}  {[hex(x) for x in hits[:10]]}")

if __name__ == '__main__':
    main()
