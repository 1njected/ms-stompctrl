"""Generate browser-probe/effect-names.json: firmware effect id -> display name.

Why this exists. A patch names its effects by 28-bit id, and the app could not
turn most of those into words. The downloadable catalog holds 117 effects, the
factory patches use 68, and only 3 are in both -- because a patch's effects are
built into the pedal rather than installed as files, so nothing in the browser
had ever seen them. The editor fell back to showing hex.

The names are in ZOOM's own StompShare bundle, whose InitialStomps directory
carries one .ZDL per factory effect with the id at offset 0x40.

This writes an INDEX, not the effects: ids and names, no binaries. It is the
same kind of metadata as catalog-index.json, and anyone with the app can
regenerate it rather than take ours on trust.

NAMES ARE FIRMWARE-ONLY; the id lists are not. An add-on's name is its
filename, which the library already carries and the Effects page already shows,
so naming add-ons here duplicated that and went stale whenever ZOOM published
one. But two membership questions have no other local answer, and both decide
what the patch editor tells you about a slot, so the file keeps them as bare id
lists -- about a kilobyte, no names:

  "factory"  the 101 ids built into the firmware. On every MS-100BT, so a slot
             holding one survives any write.
  "addons"   the 117 ids that are catalog .ZDL files. An id here that is not in
             the browser library is "not in your library", which you fix by
             importing. An id in NEITHER list is not an MS-100BT effect at all,
             which nothing fixes -- a different message with a different remedy,
             and the id alone cannot tell them apart: `08004030` reads as a
             perfectly ordinary Delay id and belongs to no effect.

Either list is omitted entirely when its source was not read, because an empty
list would assert something false rather than say nothing is known.

    python3 runtime/build-effect-names.py [path/to/StompShare.app] [fx-archive...]
"""
import glob, json, os, struct, sys

def catalog_names(here, roots=()):
    """ZDL filename -> the catalog's own display name, where one exists.

    The catalog lists "Bass Booster" for _B_BOOST.ZDL and "160 Comp" for
    160_COMP.ZDL. Those read better than a filename and cost nothing to use, so
    they win for the effects that have them. The factory set is not in the
    catalog and keeps its filename.

    Two sources, both ZOOM's own catalog data. `index.json` is what
    download-effects.py writes into an FX archive, so anyone who ran that script
    already has this and needs nothing else; `catalog-index.json` is the older
    standalone index and is still read if one is lying around."""
    names = {}
    candidates = [beside(here, "catalog-index.json")]
    candidates += [os.path.join(r, "index.json") for r in roots]
    candidates.append(beside(here, "index.json"))
    for path in candidates:
        if not path or not os.path.exists(path):
            continue
        entries = json.load(open(path)).get("effects", [])
        # catalog-index.json is a list of {zdl, name}; an FX archive's index.json
        # is {effect id: [{filename, name}, ...]}.
        rows = entries if isinstance(entries, list) else [e for v in entries.values() for e in v]
        for e in rows:
            key = e.get("zdl") or e.get("filename")
            if key and e.get("name"):
                names.setdefault(str(key).upper(), e["name"])
    return names


def app_dir(here):
    """This script sits in runtime/ in the working repo and in tools/ in the
    published one, with the app in browser-probe/ or app/ respectively. Resolve
    it rather than hardcoding one layout."""
    for rel in ("../browser-probe", "../app"):
        candidate = os.path.join(here, rel)
        if os.path.isdir(candidate):
            return candidate
    return here


def beside(here, name):
    """The named file in the app directory, or next to this script."""
    for rel in (os.path.join("..", "browser-probe", name),
                os.path.join("..", "app", name),
                name):
        candidate = os.path.join(here, rel)
        if os.path.exists(candidate):
            return candidate
    return None


def collect(root, pretty):
    found = {}
    for path in glob.glob(os.path.join(root, "**", "*.ZDL"), recursive=True):
        data = open(path, "rb").read()
        if len(data) < 0x48:
            continue
        eid = struct.unpack_from("<I", data, 0x40)[0]
        if not eid:
            continue
        base = os.path.basename(path)
        # Leading underscores mark bass and acoustic effects; the app says that
        # in words, so a filename falls back to its readable half.
        name = pretty.get(base.upper()) or base.rsplit(".", 1)[0].lstrip("_")
        found.setdefault(f"{eid:08x}", name)
    return found

def main():
    app = sys.argv[1] if len(sys.argv) > 1 else "StompShare.app"
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(app_dir(here), "effect-names.json")
    firmware_root = os.path.join(app, "InitialStomps")
    # INTERNAL EFFECTS ONLY. An add-on is a file the browser holds, and its name
    # is its filename, which the Effects page and the editor already read off
    # the library; listing add-ons here as well duplicated that and went stale
    # whenever ZOOM published one. A firmware effect is not a file anywhere the
    # browser can reach, which is the whole reason this index exists.
    roots = [firmware_root]
    # Where the add-on .ZDL files are: an FX archive from download-effects.py.
    # Extra arguments override the default location.
    catalog_roots = sys.argv[2:] or ["catalog-download/effects"]
    pretty = catalog_names(here, roots + catalog_roots)
    names, factory, saw_firmware = {}, set(), False
    for r in roots:
        if os.path.isdir(r):
            found = collect(r, pretty)
            names.update({k: v for k, v in found.items() if k not in names})
            if r == firmware_root:
                saw_firmware = True
                factory |= set(found)
            print(f"{r}: {len(found)}")
        else:
            print(f"{r}: not present, skipped")

    # The add-on ids, with their names thrown away -- see NAMES ARE
    # FIRMWARE-ONLY. Read from an FX archive, so anyone who ran
    # download-effects.py can rebuild this half without StompShare.
    addons = set()
    for r in catalog_roots:
        if os.path.isdir(r):
            addons |= set(collect(r, {}))
            print(f"{r}: {len(addons)} add-on ids")
        else:
            print(f"{r}: not present, skipped")
    addons -= factory
    if not names:
        sys.exit("No .ZDL files found. Pass the path to StompShare.app.")
    index = {"note": "effect id -> display name; an index, no binaries",
             "generated_by": "runtime/build-effect-names.py",
             "names": dict(sorted(names.items()))}
    if saw_firmware:
        index["factory_note"] = ("ids built into the firmware, so present on every MS-100BT "
                                 "and named above; an id in \"addons\" is a .ZDL that must be "
                                 "installed, and its name is its filename")
        index["factory"] = sorted(factory)
    if addons:
        index["addons"] = sorted(addons)
    print(f"wrote {len(names)} firmware names to {os.path.relpath(out, os.getcwd())}"
          + (f", {len(factory)} marked factory" if saw_firmware else ", no factory split")
          + (f", {len(addons)} add-on ids" if addons else ", no add-on id list"))
    with open(out, "w") as fh:
        json.dump(index, fh, indent=1)

if __name__ == "__main__":
    main()
