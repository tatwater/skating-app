/**
 * State boundaries from **Census TIGER**, because OSM cannot reliably give us five (N7).
 *
 *   pnpm --filter @skating/admin-areas fetch-states            # archive + transform
 *   pnpm --filter @skating/admin-areas fetch-states --refresh  # re-download
 *
 * ## Why this exists — a silent gap that had been there since Phase 5
 *
 * `adminAreas` held **three** state rows: Vermont, Maine and Massachusetts. New Hampshire and New
 * York had none, and nothing ever said so — `resolvePlace` resolves those two through their counties
 * and towns, so the label lookup worked and the hole stayed invisible until N7's merge needed a
 * five-state region mask and found it could only build three fifths of one.
 *
 * **The cause is structural, not a bad import.** A US state boundary is an OSM *relation* whose member
 * ways are shared with its neighbours. Geofabrik's per-state extract carries the relation — `r61320`
 * New York and `r67213` New Hampshire are both present, tagged `admin_level=4` — but not every member
 * way, because those ways belong as much to Québec, Ontario, Pennsylvania and Connecticut as to us.
 * `osmium export` cannot close a ring from a partial member list, so it emits nothing. Maine and
 * Vermont happen to close; New Hampshire and New York happen not to. Re-running the same import next
 * year could flip which states work, with no error either way.
 *
 * **So the fix is a source that does not need assembling.** TIGER/Line is the Census Bureau's own
 * boundary file — the legal source of record for exactly this — public domain, one 9.9 MB download
 * for all fifty states, with each state already a closed polygon. No relations, no rings to build,
 * no dependence on which ways a third-party extract happened to include.
 *
 * **Overpass was tried first and rejected**, not on principle but on behaviour: it answered for New
 * York and then timed out on New Hampshire (`Dispatcher_Client::request_read_and_idx::timeout`). A
 * shared, rate-limited service is not something an archive step should depend on when a static file
 * will do.
 *
 * ## What it does not change
 *
 * **Counties and towns stay on OSM.** They assemble reliably (all 62 New York counties export
 * cleanly), they carry the town-level granularity TIGER's state file does not, and `resolvePlace`
 * already depends on them. Only the state level moves, and it moves *entirely* — all five come from
 * TIGER so the levels are internally consistent rather than three-from-here and two-from-there.
 *
 * `externalId` becomes `tiger/<GEOID>`, which cannot collide with an OSM `relation/<id>` — so loading
 * these ADDS five rows beside the three that already exist rather than replacing them. Two polygons
 * for one state in a containment table is worse than the gap it replaces, so the three superseded
 * OSM rows are removed by `adminAreas.deleteByExternalIds`, which takes them by name and clears
 * their cell rows too. That is a separate, deliberate step; this script never deletes anything.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { MultiPolygon, Polygon } from 'geojson';
import { featureToAdminArea } from './transform';
import type { OsmBoundaryFeature } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, '..', '.raw');

/**
 * The 2024 vintage, pinned.
 *
 * TIGER publishes annually and a boundary that moves under us is a boundary we cannot reproduce a
 * campaign against. Bump this deliberately, the way `THREE_DHP_RELEASES` is bumped — and keep the
 * predecessor's checksum so "what changed this year" has an answer.
 */
export const TIGER_STATES = {
  vintage: '2024',
  url: 'https://www2.census.gov/geo/tiger/TIGER2024/STATE/tl_2024_us_state.zip',
  filename: 'tl_2024_us_state.zip',
  layer: 'tl_2024_us_state',
  bytes: 9_954_307,
  sha256: 'ad00cbe66c7177091b668cee202e93d4a1ddcee271c28d1c9f9874af59c04b92',
  licence: 'Public domain (U.S. Census Bureau, 17 U.S.C. §105)',
  attribution: 'U.S. Census Bureau, TIGER/Line Shapefiles',
} as const;

/** The five states this project covers, by USPS code. */
export const STATE_CODES = ['ME', 'NH', 'VT', 'MA', 'NY'] as const;

function log(message: string): void {
  process.stderr.write(`[states] ${message}\n`);
}

/** Download once, verify against the pinned checksum, never overwrite without `--refresh`. */
function archive(refresh: boolean): string {
  mkdirSync(RAW, { recursive: true });
  const zip = join(RAW, TIGER_STATES.filename);
  if (!existsSync(zip) || refresh) {
    log(`fetching ${TIGER_STATES.url}…`);
    const res = spawnSync(
      'curl',
      ['-sS', '--fail', '--max-time', '900', '-o', zip, TIGER_STATES.url],
      {
        encoding: 'utf8',
      },
    );
    if (res.status !== 0) throw new Error(`curl exited ${res.status}: ${res.stderr}`);
  }
  const bytes = readFileSync(zip);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // **Both checks, not one.** A truncated download has the right name and opens fine in ogr2ogr; only
  // the byte count and the digest together say it is the file we reasoned about.
  if (bytes.length !== TIGER_STATES.bytes) {
    throw new Error(`byte count ${bytes.length} != expected ${TIGER_STATES.bytes}`);
  }
  if (sha256 !== TIGER_STATES.sha256) {
    throw new Error(`sha256 ${sha256} != expected ${TIGER_STATES.sha256}`);
  }
  writeFileSync(
    join(RAW, 'states-manifest.json'),
    `${JSON.stringify({ ...TIGER_STATES, fetchedAt: new Date().toISOString(), verified: true }, null, 2)}\n`,
  );
  log(`verified ${bytes.length.toLocaleString()} bytes, sha256 ${sha256.slice(0, 16)}…`);
  return zip;
}

interface TigerProps {
  STUSPS?: string;
  NAME?: string;
  GEOID?: string;
}

/**
 * Reshape a TIGER feature into the OSM-tag shape `featureToAdminArea` already understands.
 *
 * **Reuse rather than reimplement**, and the reason is `simplifyForStorage`: Maine's TIGER outline is
 * 18,932 vertices against Convex's 8,192-element array cap, and the existing transform already knows
 * how to coarsen the least amount that fits. A second copy of that logic would drift from the first.
 */
function asOsmShaped(props: TigerProps, geometry: Polygon | MultiPolygon): OsmBoundaryFeature {
  return {
    type: 'Feature',
    properties: {
      boundary: 'administrative',
      admin_level: '4',
      name: props.NAME ?? '',
      '@type': 'tiger',
      '@id': props.GEOID ?? '',
    },
    geometry,
  };
}

function main(): void {
  const refresh = process.argv.includes('--refresh');
  const zip = archive(refresh);

  const geojson = join(RAW, 'states.geojsonl');
  // `-overwrite` does not replace a single-file datasource; ogr2ogr APPENDS, and the second run
  // silently produced ten states from five. Remove it ourselves.
  rmSync(geojson, { force: true });
  const inList = STATE_CODES.map((c) => `'${c}'`).join(',');
  const res = spawnSync(
    'ogr2ogr',
    [
      '-f',
      'GeoJSONSeq',
      geojson,
      `/vsizip/${zip}`,
      TIGER_STATES.layer,
      '-where',
      `STUSPS IN (${inList})`,
      '-select',
      'STUSPS,NAME,GEOID',
      '-t_srs',
      'EPSG:4326',
      '-dim',
      'XY',
      '-overwrite',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`ogr2ogr exited ${res.status}: ${res.stderr}`);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of readFileSync(geojson, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    const f = JSON.parse(t) as { properties: TigerProps; geometry: Polygon | MultiPolygon };
    const code = f.properties.STUSPS ?? '';
    const record = featureToAdminArea(asOsmShaped(f.properties, f.geometry));
    if (!record) throw new Error(`${code}: transform refused the feature`);
    seen.add(code);
    // The loader stamps `state` from `--state=XX`; these are per-state rows, so it rides along here.
    // **One file per state, because the loader stamps `state` from a single `--state=XX` flag.**
    // Writing all five into one file and loading it five times would label New York as Maine four
    // times over — and `state` is denormalised onto every place label a user reads.
    writeFileSync(join(RAW, `states-${code.toLowerCase()}.ndjson`), `${JSON.stringify(record)}\n`);
    out.push(JSON.stringify({ ...record, state: code }));
    log(`${code} ${record.name} → ${record.externalId}`);
  }

  // **Assert all five, because the failure this file exists to fix was a MISSING row.** Shipping four
  // silently is the same bug in a new costume.
  const missing = STATE_CODES.filter((c) => !seen.has(c));
  if (missing.length > 0) throw new Error(`missing states: ${missing.join(', ')}`);

  const ndjson = join(RAW, 'states.ndjson');
  writeFileSync(ndjson, `${out.join('\n')}\n`);
  log(`${out.length} states → ${ndjson}`);
  for (const code of STATE_CODES) {
    log(
      `  pnpm --filter @skating/admin-areas load .raw/states-${code.toLowerCase()}.ndjson --state=${code}`,
    );
  }
}

try {
  main();
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
