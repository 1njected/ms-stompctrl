"""Generate browser-probe/effect-names.json: effect id -> display name.

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

    python3 runtime/build-effect-names.py [path/to/StompShare.app]
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
    roots = [os.path.join(app, "InitialStomps"), "catalog-download/effects"]
    pretty = catalog_names(here, roots)
    names = {}
    for r in roots:
        if os.path.isdir(r):
            found = collect(r, pretty)
            names.update({k: v for k, v in found.items() if k not in names})
            print(f"{r}: {len(found)}")
        else:
            print(f"{r}: not present, skipped")
    if not names:
        sys.exit("No .ZDL files found. Pass the path to StompShare.app.")
    with open(out, "w") as fh:
        json.dump({"note": "effect id -> display name; an index, no binaries",
                   "generated_by": "runtime/build-effect-names.py",
                   "names": dict(sorted(names.items()))}, fh, indent=1)
    print(f"wrote {len(names)} names to {os.path.relpath(out, os.getcwd())}")

if __name__ == "__main__":
    main()
