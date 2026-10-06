"""Generate app/effect-params.json: effect id -> its knobs and their defaults.

Why this exists. The patch editor could only offer an effect whose parameter
block some loaded patch already contained, because a slot carries fourteen
bytes that mean whatever the effect's own code says and nothing could invent
them. The values were never the hard part: every `.ZDL` states its own
min/default/max per parameter, in the registration struct the loader reads. This
pulls them out, so the editor can place an effect no patch of yours uses.

Where they are. The `.ZDL` is a TI C6000 shared object (docs/protocol.md 7.1).
In `.const` sits a registration struct of 48-byte blocks:

    +0x00  12 bytes  name, NUL padded
    +0x0c  u32       max
    +0x10  u32       default
    +0x14  u32       a second bound, equal to max or zero
    +0x1c  u32       this parameter's edit handler
    +0x24  u32       a display-string helper, where one exists

Block 0 is always `OnOff`, the bypass pseudo-parameter that lives in the id
word's bit 0 rather than in the parameter bytes. Block 1 is the effect itself --
its name, its init routine, its audio routine, and 0xffffffff where a max would
be, which is how it is told apart. Blocks 2 onward are the knobs, in the order
the pedal numbers them, at most nine. That `OnOff` signature is what locates the
struct: of 218 files, 217 have exactly one symbol in `.const` whose size is a
multiple of 48 and whose first block is named `OnOff`.

INTERNAL EFFECTS ONLY. This writes the firmware set and nothing else, because
an add-on is a file the browser holds: `app/zdl.js` descriptor() is this same
parser in JavaScript, and `patch-params.js` runs it over the stored `.ZDL`s on
every load. Listing add-ons here too meant 47 KB of JSON repeating what those
files already say, and an effect ZOOM published after the index was built had no
defaults until somebody with StompShare re-ran this. The firmware effects have
no file anywhere the browser can reach, which is exactly why they need an index.

What is written is an INDEX, the same kind as effect-names.json: ids, knob names
and three small integers each. No binaries, nothing that is not regenerable from
files anyone with the app already has.

A caveat the file records for its readers. A stored number is not always the
displayed one -- the pedal shows ZNR THRSH as 1-25 over a stored 0-24 -- and the
scaling lives in the effect's edit handler, which this does not read. Defaults
are exact, which is all the editor needs; a *displayed* value would be a guess.

    python3 tools/build-effect-params.py [path/to/StompShare.app] [more roots...]

Extra roots are read if given, for anyone who wants an index covering add-ons as
well; the app does not need one.
"""
import glob, json, os, struct, sys

MAX_PARAMS = 9          # p0..p8; the patch layout has nowhere to put a tenth
BLOCK = 48


def elf_base(data):
    return data.find(b'\x7fELF')


def sections(data, base):
    """ELF32 little-endian section headers, offsets rebased into the file."""
    e_shoff, = struct.unpack_from('<I', data, base + 0x20)
    e_shentsize, = struct.unpack_from('<H', data, base + 0x2e)
    e_shnum, = struct.unpack_from('<H', data, base + 0x30)
    e_shstrndx, = struct.unpack_from('<H', data, base + 0x32)
    secs = []
    for i in range(e_shnum):
        o = base + e_shoff + i * e_shentsize
        f = struct.unpack_from('<10I', data, o)
        secs.append(dict(nameoff=f[0], type=f[1], addr=f[3],
                         off=base + f[4], size=f[5]))
    stroff = secs[e_shstrndx]['off']
    for s in secs:
        end = data.index(b'\0', stroff + s['nameoff'])
        s['name'] = data[stroff + s['nameoff']:end].decode('latin1')
    return secs


def symbols(data, secs):
    by = {s['name']: s for s in secs if s['name'] not in ()}
    if '.symtab' not in by or '.strtab' not in by:
        return []
    sym, strt = by['.symtab'], by['.strtab']
    out = []
    for i in range(sym['size'] // 16):
        nameoff, value, size, _info, _other, _sh = struct.unpack_from('<IIIBBH', data, sym['off'] + i * 16)
        end = data.index(b'\0', strt['off'] + nameoff)
        out.append((data[strt['off'] + nameoff:end].decode('latin1'), value, size))
    return out


def cstr(b):
    return b.split(b'\0')[0].decode('latin1')


def knobs(path):
    """The effect's parameters, or None if the descriptor cannot be located."""
    data = open(path, 'rb').read()
    base = elf_base(data)
    if base < 0:
        return None
    secs = sections(data, base)
    consts = [s for s in secs if s['name'] == '.const' and s['type'] == 1 and s['size']]
    if not consts:
        return None
    const = consts[0]
    for name, value, size in sorted(symbols(data, secs), key=lambda s: s[1]):
        if not (name and size and size % BLOCK == 0):
            continue
        if not const['addr'] <= value < const['addr'] + const['size']:
            continue
        blob = data[const['off'] + (value - const['addr']):][:size]
        if len(blob) < 2 * BLOCK or cstr(blob[0:12]) != 'OnOff':
            continue
        out = []
        for i in range(2 * BLOCK, len(blob) - BLOCK + 1, BLOCK):
            blk = blob[i:i + BLOCK]
            hi, dflt = struct.unpack_from('<II', blk, 12)
            if hi > 0xfffffff:          # the effect header, not a knob
                continue
            out.append({'name': cstr(blk[0:12]), 'max': hi, 'def': dflt})
        return out[:MAX_PARAMS]
    return None


def app_dir(here):
    for rel in ('../browser-probe', '../app'):
        candidate = os.path.join(here, rel)
        if os.path.isdir(candidate):
            return candidate
    return here


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    args = sys.argv[1:] or ['StompShare.app']
    # InitialStomps of the first argument is the firmware set; anything further
    # is an opt-in extra root. No catalog directory is read by default -- see
    # INTERNAL EFFECTS ONLY above.
    roots = [os.path.join(args[0], 'InitialStomps')] + args[1:]
    found, skipped = {}, []
    for root in roots:
        if not os.path.isdir(root):
            print(f'{root}: not present, skipped')
            continue
        n = 0
        for path in sorted(glob.glob(os.path.join(root, '**', '*.ZDL'), recursive=True)):
            data = open(path, 'rb').read()
            if len(data) < 0x48:
                continue
            eid = struct.unpack_from('<I', data, 0x40)[0]
            if not eid or f'{eid:08x}' in found:
                continue
            ks = knobs(path)
            if ks is None:
                skipped.append(os.path.basename(path))
                continue
            found[f'{eid:08x}'] = ks
            n += 1
        print(f'{root}: {n}')
    if not found:
        sys.exit('No .ZDL files found. Pass the path to StompShare.app.')
    out = os.path.join(app_dir(here), 'effect-params.json')
    index = {
        'note': 'effect id -> its knobs, as the .ZDL descriptor states them; an index, no binaries',
        'generated_by': 'tools/build-effect-params.py',
        'caveat': 'def/max are stored values, not displayed ones; an effect may scale or offset '
                  'them for its display (ZNR THRSH shows 1-25 over a stored 0-24)',
        'params': dict(sorted(found.items())),
    }
    with open(out, 'w') as fh:
        json.dump(index, fh, indent=1)
    print(f'wrote {len(found)} effects to {os.path.relpath(out, os.getcwd())}'
          + (f', {len(skipped)} without a descriptor: {", ".join(skipped)}' if skipped else ''))


if __name__ == '__main__':
    main()
