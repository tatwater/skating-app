#!/usr/bin/env python3
"""
Rename one top-level key in every archive `manifest.json` under the `.raw*` directories.

The US-spellings sweep (D185) renamed the manifest field `licence` to `license`, and the field is
load-bearing: `isRunnable()` in `scripts/lake-depth` refuses an archive whose manifest records no
license, and the wind-climate and ETL snapshots stamp it into provenance. Every manifest written
before the rename — a handful for the depth, NHD, 3DHP, GNIS and TIGER archives, ~9,500 per-grid-point
ones for the NREL wind archive — carries the old key, so the readers would see `undefined` and stop.

Rules, in one place:

  * Dry by default. `--apply` writes; without it the script only reports what it would touch.
  * Atomic writes — tmp file beside the manifest, then `os.replace`. A crash mid-run leaves every
    manifest either old or new, never truncated.
  * Byte-faithful otherwise: two-space indent and a trailing newline, exactly as
    `JSON.stringify(manifest, null, 2) + '\\n'` writes them, so a `git diff`-style comparison of an
    untouched manifest is empty and the R2 mirrors re-upload only what changed.
  * A manifest that already has the new key is left alone; one that has both is an error, not a guess.

After `--apply`, push each archive's mirror (`scripts/<pkg>/mirror*-r2.sh push`) so the R2 copies
carry the same key — the mirrors are `rclone copy`, so this is additive.

Usage:
  python3 scripts/lib/rename-manifest-key.py --from licence --to license [--root scripts] [--apply]
"""

import argparse
import json
import os
import sys
from pathlib import Path


def find_manifests(root: Path):
    """Every `*manifest.json` under a `.raw*` directory, at any depth."""
    for dirpath, dirnames, filenames in os.walk(root):
        parts = Path(dirpath).parts
        if not any(p.startswith('.raw') for p in parts):
            # Only descend into `.raw*` trees; skip `node_modules` and the like on the way.
            dirnames[:] = [d for d in dirnames if d.startswith('.raw') or not d.startswith(('.', 'node_modules'))]
            continue
        for name in filenames:
            # `manifest.json`, and the TIGER archive's `states-manifest.json`.
            if name.endswith('manifest.json'):
                yield Path(dirpath) / name


def rewrite(path: Path, old: str, new: str, apply: bool) -> str:
    text = path.read_text(encoding='utf-8')
    data = json.loads(text)
    if not isinstance(data, dict):
        return 'skip:not-an-object'
    if old not in data:
        return 'skip:already' if new in data else 'skip:no-key'
    if new in data:
        raise SystemExit(f'{path}: has both "{old}" and "{new}" — resolve by hand')
    # Rebuild in key order so the renamed key keeps its position.
    renamed = {(new if k == old else k): v for k, v in data.items()}
    out = json.dumps(renamed, indent=2, ensure_ascii=False) + '\n'
    # Sanity: the only difference must be the key itself.
    if json.dumps(data, indent=2, ensure_ascii=False) + '\n' != text:
        return 'skip:not-canonical'  # formatted by something other than JSON.stringify(…, null, 2)
    if apply:
        tmp = path.with_suffix('.json.tmp')
        tmp.write_text(out, encoding='utf-8')
        os.replace(tmp, path)
    return 'renamed'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--from', dest='old', required=True)
    ap.add_argument('--to', dest='new', required=True)
    ap.add_argument('--root', default='scripts')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    counts: dict[str, int] = {}
    by_archive: dict[str, int] = {}
    for path in find_manifests(Path(args.root)):
        outcome = rewrite(path, args.old, args.new, args.apply)
        counts[outcome] = counts.get(outcome, 0) + 1
        if outcome == 'renamed':
            archive = '/'.join(path.parts[:3])  # scripts/<pkg>/.raw*
            by_archive[archive] = by_archive.get(archive, 0) + 1
        if outcome.startswith('skip:not'):
            print(f'  ! {outcome} {path}', file=sys.stderr)

    verb = 'renamed' if args.apply else 'would rename'
    print(f'{verb} {counts.get("renamed", 0)} manifest(s); ' + ', '.join(f'{k}={v}' for k, v in sorted(counts.items())))
    for archive, n in sorted(by_archive.items()):
        print(f'  {n:6}  {archive}')
    if not args.apply:
        print('(dry run — pass --apply to write)')
    return 1 if any(k.startswith('skip:not') for k in counts) else 0


if __name__ == '__main__':
    raise SystemExit(main())
