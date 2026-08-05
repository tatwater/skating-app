/**
 * Archive the GNIS Domestic Names gazetteer — the fourth catalogue (N7, D105).
 *
 *   pnpm --filter @skating/etl archive-gnis            # fetch + verify + manifest
 *   pnpm --filter @skating/etl archive-gnis --refresh  # re-fetch, accepting a new upstream version
 *
 * ## Why this is a permanent archive and not scratch
 *
 * **The URL carries no vintage.** `DomesticNames_VT_Text.zip` is overwritten in place on every
 * publication — checked 2026-08-05, `Last-Modified: 2026-07-06` — and the `Archive/` prefix beside it
 * holds the retired pre-2021 *MainDomestic* format, not dated snapshots of these files. So today's
 * gazetteer is not recoverable tomorrow, exactly like Geofabrik's `-latest`.
 *
 * **And here that matters more than it does for a reference table**, because of what a GNIS name
 * does: D96 admits a *named* wetland at five acres and refuses an unnamed one under fifty, so a name
 * from this file decides whether a body is in the corpus at all. An un-pinned gazetteer means the
 * corpus changes shape between runs for a reason nothing records.
 *
 * Contrast **TIGER**, which is deliberately *not* archived: its vintage is in the URL and the Census
 * Bureau still serves TIGER2020 (verified). Pinning the year and the checksum makes that one
 * reproducible without spending a byte of R2.
 *
 * ## The file
 *
 * Pipe-delimited text with a UTF-8 BOM, one row per named feature, ~2.77 MB zipped across five
 * states. Public domain (U.S. Board on Geographic Names). Columns we read: `feature_name`,
 * `feature_class`, `prim_lat_dec`, `prim_long_dec`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Permanent, mirrored, never `.scratch/`. See the header. */
export const GNIS_DIR = join(HERE, '..', '.raw-gnis');

/** The five states, by the code the staged filenames use. */
export const GNIS_STATE_CODES = ['ME', 'NH', 'VT', 'MA', 'NY'] as const;

export const gnisUrl = (code: string) =>
  `https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_${code}_Text.zip`;

/** Where the extracted text lands, and what `merge` reads. */
export const gnisTextPath = (code: string) => join(GNIS_DIR, `DomesticNames_${code}.txt`);

/**
 * GNIS classes that describe a **body of water** rather than a line or a point.
 *
 * `Stream` and `Spring` are excluded deliberately: GNIS gives one coordinate per feature, and for a
 * stream that point is somewhere along its length. Letting it name the polygon it happens to fall
 * inside would christen a lake after the brook running through it.
 */
export const GNIS_WATER_CLASSES: ReadonlySet<string> = new Set([
  'Lake',
  'Reservoir',
  'Swamp',
  'Bay',
]);

/**
 * GNIS's "no coordinate" — and it is a **location**, not a blank.
 *
 * `0.0, 0.0` is in the Gulf of Guinea. Read as a position it would pile every unplaced feature into
 * one grid cell off the coast of Africa; read as a name source it would silently do nothing, which
 * is worse because nothing would say so. Same shape as NHD's `gnis_id = -1`, which would have
 * collapsed 855 unrelated lakes onto one body.
 */
export function isNullIsland(lat: number, lng: number): boolean {
  return lat === 0 && lng === 0;
}

function log(message: string): void {
  process.stderr.write(`[gnis] ${message}\n`);
}

export interface GnisStateManifest {
  code: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Upstream's `Last-Modified`, the only version marker these files carry. */
  lastModified: string;
  fetchedAt: string;
  rows: number;
  waterRows: number;
}

/** Fetch, verify, extract and record one state. */
function archiveState(code: string, refresh: boolean): GnisStateManifest {
  mkdirSync(GNIS_DIR, { recursive: true });
  const zip = join(GNIS_DIR, `DomesticNames_${code}_Text.zip`);
  const url = gnisUrl(code);

  let lastModified = '';
  if (!existsSync(zip) || refresh) {
    log(`${code}: fetching…`);
    const head = spawnSync('curl', ['-sSI', '--max-time', '120', url], { encoding: 'utf8' });
    lastModified = /last-modified:\s*(.+)/i.exec(head.stdout ?? '')?.[1]?.trim() ?? '';
    const res = spawnSync('curl', ['-sS', '--fail', '--max-time', '300', '-o', zip, url], {
      encoding: 'utf8',
    });
    if (res.status !== 0) throw new Error(`${code}: curl exited ${res.status}: ${res.stderr}`);
  }

  const bytes = readFileSync(zip);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // **Unzip OUTSIDE the archive.** Extracting in place left a `_ME/Text/…` tree beside the zip, and
  // the mirror faithfully backed all of it up — 23 MiB pushed for 2.8 MiB of source, most of it the
  // same text twice plus the browse thumbnails nobody reads. An archive directory should hold the
  // artifact and the thing derived from it, not the scaffolding in between.
  const staging = join(tmpdir(), `gnis-${code}`);
  rmSync(staging, { recursive: true, force: true });
  const un = spawnSync('unzip', ['-o', '-q', zip, '-d', staging], { encoding: 'utf8' });
  if (un.status !== 0) throw new Error(`${code}: unzip exited ${un.status}`);
  const inner = join(staging, 'Text', `DomesticNames_${code}.txt`);
  if (!existsSync(inner)) throw new Error(`${code}: expected ${inner} inside the archive`);

  const text = readFileSync(inner, 'utf8');
  writeFileSync(gnisTextPath(code), text);
  rmSync(staging, { recursive: true, force: true });

  // Count as we go, so the manifest records what the file actually held rather than what it should
  // have. A silently truncated gazetteer would otherwise look like a state with fewer lakes.
  const lines = text.replace(/^﻿/, '').split('\n');
  const header = (lines[0] ?? '').split('|');
  const classIx = header.indexOf('feature_class');
  if (classIx < 0)
    throw new Error(`${code}: no feature_class column — header ${header.slice(0, 5)}`);
  let rows = 0;
  let waterRows = 0;
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue;
    rows++;
    if (GNIS_WATER_CLASSES.has(line.split('|')[classIx] ?? '')) waterRows++;
  }

  log(
    `${code}: ${bytes.length.toLocaleString()} bytes · ${rows.toLocaleString()} names · ${waterRows.toLocaleString()} water`,
  );
  return {
    code,
    url,
    bytes: bytes.length,
    sha256,
    lastModified,
    fetchedAt: new Date().toISOString(),
    rows,
    waterRows,
  };
}

function main(): void {
  const refresh = process.argv.includes('--refresh');
  const states = GNIS_STATE_CODES.map((code) => archiveState(code, refresh));
  const total = states.reduce((n, s) => n + s.waterRows, 0);
  writeFileSync(
    join(GNIS_DIR, 'manifest.json'),
    `${JSON.stringify(
      {
        source: 'USGS / U.S. Board on Geographic Names — GNIS Domestic Names',
        licence: 'Public domain (U.S. Government work, 17 U.S.C. §105)',
        note: 'The staged URL carries no vintage and is overwritten in place; this archive IS the version record.',
        waterClasses: [...GNIS_WATER_CLASSES],
        states,
      },
      null,
      2,
    )}\n`,
  );
  log(`${states.length} states archived → ${GNIS_DIR} (${total.toLocaleString()} water features)`);
  log('mirror with: scripts/etl/mirror-gnis-r2.sh push');
}

try {
  main();
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
