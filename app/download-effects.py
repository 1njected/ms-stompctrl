#!/usr/bin/env python3
"""Download the ZOOM StompShare catalog and build an FX archive for the browser.

    python3 browser-probe/download-effects.py

Each effect package on ZOOM's server carries its binary and its artwork. Both go
into the archive, because the web app hosts neither: it keeps everything in the
importing browser's own storage.

    index.json          catalog: ids, filenames, versions, artwork
    *.ZDL               effect binaries
    artwork/<id>.png    one image per effect, named by effect ID

Artwork is named by the effect ID read from the binary itself, at ZDL offset
0x40, because that is the key the importer resolves images by.

Needs nothing else. The catalog index is fetched from ZOOM if it is not already
beside the script, so this works from any directory with no StompShare copy.
"""
import io
import json
import plistlib
import struct
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# This script is offered from the Effects page as a standalone download, so it
# must not assume it sits inside the repository. Everything is relative to the
# working directory, with the repo's own cache used when it happens to be there.
HERE = Path.cwd()
OUT = HERE / 'ms-stompctrl-fx-archive.zip'
BASE = 'https://www.zoom.co.jp/archive/stomp_share/Stomps/'
CATALOG = BASE + 'ExtStomps.plist'
CACHED = (
    HERE / 'ExtStomps.plist',
    HERE / 'catalog-download' / 'ExtStomps.plist',
    Path(__file__).resolve().parent.parent / 'catalog-download' / 'ExtStomps.plist',
)

# In preference order. A package usually has several sizes of the same image.
IMAGE_NAMES = ('thumbnail.png', 'image_on.png', 'image_on@2x.png', 'image_off.png')


def load_catalog() -> dict:
    """The catalog index, from disk if present, otherwise from ZOOM.

    A downloaded copy is cached beside the script so a rerun after a failure
    does not fetch it again. It was verified byte-identical to the copy the app
    keeps in its own cache.
    """
    for path in CACHED:
        if path.is_file():
            print(f'Catalog: {path}')
            return plistlib.loads(path.read_bytes())['Stomps']
    print(f'Catalog: downloading {CATALOG}')
    with urllib.request.urlopen(CATALOG) as response:
        raw = response.read()
    catalog = plistlib.loads(raw)['Stomps']       # parse before caching a bad file
    try:
        CACHED[0].write_bytes(raw)
        print(f'         cached as {CACHED[0]}')
    except OSError as exc:
        print(f'         not cached: {exc}', file=sys.stderr)
    return catalog


def identity(zdl: bytes) -> tuple[str, str]:
    """Effect ID and version, from the binary's own header."""
    if len(zdl) < 76:
        raise ValueError('ZDL too short to carry an effect ID')
    effect_id = struct.unpack_from('<I', zdl, 0x40)[0]
    version = zdl[0x44:0x4C].split(b'\0')[0].decode('ascii', 'replace')
    return f'{effect_id:08x}', version


def pick_image(package: zipfile.ZipFile) -> tuple[str, bytes] | None:
    names = package.namelist()
    for wanted in IMAGE_NAMES:
        for name in names:
            if name.rsplit('/', 1)[-1].lower() == wanted:
                return name, package.read(name)
    return None


def main() -> int:
    try:
        catalog = load_catalog()
    except (urllib.error.URLError, plistlib.InvalidFileException, KeyError) as exc:
        print(f'Could not read the catalog: {exc}', file=sys.stderr)
        return 1
    index: dict[str, list[dict]] = {}
    effects = images = failed = 0

    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for position, (_key, effect) in enumerate(sorted(catalog.items()), 1):
            directory, zdl_name = effect['directory'], effect['zdl']
            label = effect.get('name', directory)
            print(f'[{position}/{len(catalog)}] {label}…', flush=True)
            try:
                with urllib.request.urlopen(BASE + directory + '.zip') as response:
                    package = zipfile.ZipFile(io.BytesIO(response.read()))
            except (urllib.error.URLError, zipfile.BadZipFile) as exc:
                print(f'    skipped: {exc}', file=sys.stderr)
                failed += 1
                continue

            with package:
                entry = next((n for n in package.namelist() if n.lower().endswith('.zdl')), None)
                if entry is None:
                    print('    skipped: no .ZDL in package', file=sys.stderr)
                    failed += 1
                    continue
                data = package.read(entry)
                picture = pick_image(package)

            try:
                effect_id, version = identity(data)
            except ValueError as exc:
                print(f'    skipped: {exc}', file=sys.stderr)
                failed += 1
                continue

            # The pedal knows the bare filename, so that is what the archive uses.
            bundle.writestr(zdl_name, data)
            effects += 1
            artwork = None
            if picture:
                artwork = f'artwork/{effect_id}.png'
                # One image per effect: two variants of one effect share an ID
                # and would otherwise collide in the archive.
                if artwork not in bundle.namelist():
                    bundle.writestr(artwork, picture[1])
                    images += 1

            index.setdefault(effect_id, []).append({
                'effectId': effect_id, 'filename': zdl_name, 'version': version,
                'bytes': len(data), 'artwork': artwork, 'name': effect.get('name'),
                'source': f'{BASE}{directory}.zip',
            })

        bundle.writestr('index.json', json.dumps(
            {'formatVersion': 1, 'effects': index, 'installedVersionsVerified': False},
            indent=2) + '\n')

    print(f'\n{OUT.name}: {effects} effects, {images} images'
          + (f', {failed} failed' if failed else ''))
    print('Import it with "Import FX archive" on the Effects page.')
    return 1 if effects == 0 else 0


if __name__ == '__main__':
    raise SystemExit(main())
