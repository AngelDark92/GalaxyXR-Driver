#!/usr/bin/env python3
"""Read-only companion icon/help contract checks; requires Pillow.

Usage: python tools/Test-CompanionAssets.py [--report path/to/results.json]
Does not generate assets, launch SteamVR or edit user configuration.
"""
from __future__ import annotations
import argparse
from collections import Counter
from io import BytesIO
import json
from pathlib import Path
import re
import struct
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    checks: list[dict] = []
    def check(name: str, passed: bool) -> None:
        checks.append({'test': name, 'passed': bool(passed)})
        print(('PASS ' if passed else 'FAIL ') + name)
    gui = ROOT / 'GalaxyXRDriverGUI'
    icons = gui / 'src-tauri/icons'
    raw = (icons / 'icon.ico').read_bytes()
    reserved, kind, count = struct.unpack_from('<HHH', raw)
    check('ICO header is valid and contains 13 entries', (reserved, kind, count) == (0, 1, 13))
    sizes, frames = [], []
    for i in range(count):
        w, h, colors, _, planes, depth, length, offset = struct.unpack_from('<BBBBHHII', raw, 6 + i * 16)
        size = w or 256; sizes.append(size)
        check(f'ICO {size}px frame has correct dimensions and 32-bit metadata', size == (h or 256) and planes == 1 and depth == 32 and offset + length <= len(raw))
        with Image.open(BytesIO(raw[offset:offset + length])) as image:
            frames.append(image.size == (size, size) and image.mode == 'RGBA' and image.getchannel('A').getbbox() is not None and image.getextrema()[3][0] == 0)
    check('All embedded ICO frames are nonempty transparent RGBA images', all(frames))
    check('ICO begins with 32px and contains Tauri-required sizes', sizes[0] == 32 and {16, 24, 32, 48, 64, 256}.issubset(sizes))
    check('Additional Windows scaling sizes are present without duplicates', len(set(sizes)) == len(sizes) and {20, 28, 40, 56, 80, 96, 128}.issubset(sizes))
    for name, size in [('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256), ('icon.png', 512)]:
        with Image.open(icons / name) as image:
            check(f'Tauri {name} is square RGBA', image.size == (size, size) and image.mode == 'RGBA')
    check('Both public favicon paths agree', (gui / 'public/favicon.ico').read_bytes() == (gui / 'public/icons/favicon.ico').read_bytes())
    driver = ROOT / 'GalaxyXRDriver/DriverFiles/resources/icons/galaxy_xr'
    assets = sorted(p for p in (gui / 'public/icons').glob('headset_galaxy_xr_*') if p.suffix in ('.png', '.gif'))
    check('All 14 supplied status assets are available', len(assets) == 14)
    for image_file in assets:
        target = driver / image_file.name
        check('Driver keeps original GUI artwork bytes: ' + image_file.name, target.is_file() and target.read_bytes() == image_file.read_bytes())
        with Image.open(image_file) as image:
            expected = (100, 64) if '_2x' in image_file.stem else (50, 32)
            check('Supplied dimensions/animation retained: ' + image_file.name, image.size == expected and (image_file.suffix != '.gif' or image.n_frames > 1))
    header = (ROOT / 'GalaxyXRDriver/src/Headsets/GalaxyXRStatusIcons.h').read_text()
    mapped = re.findall(r'\{vr::(Prop_\w+), "([^"]+)"\}', header)
    check('Nine distinct OpenVR status properties are declared', len(mapped) == 9 and len({x[0] for x in mapped}) == 9)
    check('Every driver status points to supplied base and matching 2x art', all((driver / name).is_file() and (driver / (Path(name).stem + '_2x' + Path(name).suffix)).is_file() for _, name in mapped))
    catalog = json.loads((ROOT / 'Docs/Galaxy-XR-Companion/help-catalog.json').read_text())
    check('178 help entries contain a plain summary and technical details', len(catalog) == 178 and all(x['summary'].strip() and x['details'].strip() for x in catalog))
    expected_by_file: dict[str, Counter] = {}
    for entry in catalog:
        text = json.dumps(entry['summary'] + '\n\n' + entry['details'], ensure_ascii=False)
        expected_by_file.setdefault(entry['source'], Counter())[text] += 1
    check('Every documented help entry matches its current TypeScript source', all((gui / 'src-lit' / filename).read_text().count(literal) >= count for filename, items in expected_by_file.items() for literal, count in items.items()))
    check('Main document title uses Galaxy XR Companion', '<title>Galaxy XR Companion</title>' in (gui / 'index.html').read_text())
    report = {'scope': 'Read-only file, artwork and source-contract checks. Does not verify Windows shell rendering, a native build or SteamVR runtime.', 'checks': checks}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    failures = sum(not item['passed'] for item in checks)
    print(f'{len(checks) - failures}/{len(checks)} companion asset/catalog checks passed')
    if failures:
        raise SystemExit(1)

if __name__ == '__main__':
    main()
