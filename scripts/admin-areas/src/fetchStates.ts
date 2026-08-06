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
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { MultiPolygon, Polygon } from 'geojson';
import {
  archive as archiveVerified,
  makeLog,
  RAW,
  STATES,
  TIGER_COUNTIES,
  TIGER_COUSUB_URL,
  TIGER_STATES,
} from './tiger';
import { featureToAdminArea } from './transform';
import type { OsmBoundaryFeature } from './types';

// Re-exported because this module was their home before `buildRegion.ts` needed them too, and the
// commit history and runbooks both point here. The definitions live in `./tiger`.
export { STATE_CODES, STATES, TIGER_COUNTIES, TIGER_COUSUB_URL, TIGER_STATES } from './tiger';

const log = makeLog('states');

/** `archive` with this script's logger already bound — the call sites read as they always did. */
function archive(
  source: { url: string; filename: string; bytes?: number; sha256?: string },
  refresh: boolean,
  manifestName?: string,
): string {
  return archiveVerified(source, refresh, log, manifestName);
}

interface TigerProps {
  STUSPS?: string;
  STATEFP?: string;
  NAME?: string;
  NAMELSAD?: string;
  GEOID?: string;
}

/**
 * Reshape a TIGER feature into the OSM-tag shape `featureToAdminArea` already understands.
 *
 * **Reuse rather than reimplement**, and the reason is `simplifyForStorage`: Maine's TIGER outline is
 * 18,932 vertices against Convex's 8,192-element array cap, and the existing transform already knows
 * how to coarsen the least amount that fits. A second copy of that logic would drift from the first.
 */
function asOsmShaped(
  props: TigerProps,
  adminLevel: string,
  geometry: Polygon | MultiPolygon,
): OsmBoundaryFeature {
  return {
    type: 'Feature',
    properties: {
      boundary: 'administrative',
      admin_level: adminLevel,
      name: props.NAME ?? '',
      '@type': 'tiger',
      '@id': props.GEOID ?? '',
    },
    geometry,
  };
}

/**
 * Pull one TIGER layer through the transform that already knows how to store a boundary.
 *
 * `adminLevel` is the OSM number `levelFromAdminLevel` speaks — 4 state, 6 county, 8 town — because
 * reusing that mapping is what keeps TIGER-sourced and OSM-sourced rows describing the same tiers.
 */
function extract(
  zip: string,
  layer: string,
  where: string,
  adminLevel: string,
  outName: string,
  // **Per layer, because TIGER's schemas differ.** The state layer has `NAME` and no `NAMELSAD`;
  // county and cousub have both. Selecting a field a layer lacks is a hard ogr2ogr failure, which is
  // the good outcome — the bad one would be selecting nothing and silently losing the label suffix.
  select = 'STATEFP,NAME,NAMELSAD,GEOID',
  // **Which TIGER name column becomes the label, and it differs by level.** A county wants
  // `NAMELSAD` — the label users read is "Merrimack County", not "Merrimack". A *town* does not:
  // NAMELSAD appends the legal class, so it yields "Concord city", "Exeter town" and "Brooklyn
  // borough", which is a suffix nobody says out loud and which the OSM rows never carried.
  useNamelsad = true,
): { code: string; record: ReturnType<typeof featureToAdminArea> }[] {
  const geojson = join(RAW, outName);
  // `-overwrite` does not replace a single-file datasource; ogr2ogr APPENDS, and the second run
  // silently produced ten states from five. Remove it ourselves.
  rmSync(geojson, { force: true });
  const res = spawnSync(
    'ogr2ogr',
    [
      '-f',
      'GeoJSONSeq',
      geojson,
      `/vsizip/${zip}`,
      layer,
      '-where',
      where,
      '-select',
      select,
      '-t_srs',
      'EPSG:4326',
      '-dim',
      'XY',
      '-overwrite',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`ogr2ogr ${layer} exited ${res.status}: ${res.stderr}`);

  const byFips = new Map<string, string>(STATES.map((s) => [s.fips, s.code]));
  const out: { code: string; record: ReturnType<typeof featureToAdminArea> }[] = [];
  for (const line of readFileSync(geojson, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    const f = JSON.parse(t) as { properties: TigerProps; geometry: Polygon | MultiPolygon };
    const code = byFips.get(f.properties.STATEFP ?? '') ?? '';
    if (!code) continue;
    const name =
      (useNamelsad ? f.properties.NAMELSAD : f.properties.NAME) ?? f.properties.NAME ?? '';
    out.push({
      code,
      record: featureToAdminArea(
        asOsmShaped({ ...f.properties, NAME: name }, adminLevel, f.geometry),
      ),
    });
  }
  return out;
}

/** Expected county counts, so a silently short download fails instead of shipping a hole. */
const EXPECTED_COUNTIES: Record<string, number> = { ME: 16, NH: 10, VT: 14, MA: 14, NY: 62 };

function main(): void {
  const refresh = process.argv.includes('--refresh');
  const byState = new Map<string, string[]>(STATES.map((s) => [s.code, []]));
  const counts: Record<string, Record<string, number>> = {};
  const tally = (level: string, code: string) => {
    const forLevel = counts[level] ?? {};
    forLevel[code] = (forLevel[code] ?? 0) + 1;
    counts[level] = forLevel;
  };

  const push = (
    code: string,
    record: NonNullable<ReturnType<typeof featureToAdminArea>>,
    level: string,
  ) => {
    byState.get(code)?.push(JSON.stringify(record));
    tally(level, code);
  };

  // ── states ────────────────────────────────────────────────────────────────
  log('states…');
  const stateZip = archive(TIGER_STATES, refresh, 'states-manifest.json');
  const fipsList = STATES.map((s) => `'${s.fips}'`).join(',');
  for (const { code, record } of extract(
    stateZip,
    TIGER_STATES.layer,
    `STATEFP IN (${fipsList})`,
    '4',
    'states.geojsonl',
    'STATEFP,NAME,GEOID',
  )) {
    if (!record) throw new Error(`${code}: transform refused a state`);
    push(code, record, 'state');
  }

  // ── counties ──────────────────────────────────────────────────────────────
  log('counties…');
  const countyZip = archive(TIGER_COUNTIES, refresh, 'counties-manifest.json');
  for (const { code, record } of extract(
    countyZip,
    TIGER_COUNTIES.layer,
    `STATEFP IN (${fipsList})`,
    '6',
    'counties.geojsonl',
  )) {
    if (!record) throw new Error(`${code}: transform refused a county`);
    push(code, record, 'county');
  }

  // ── towns (county subdivisions), published per state ──────────────────────
  log('towns…');
  for (const { code, fips } of STATES) {
    const zip = archive(
      { url: TIGER_COUSUB_URL(fips), filename: `tl_2024_${fips}_cousub.zip` },
      refresh,
    );
    for (const { record } of extract(
      zip,
      `tl_2024_${fips}_cousub`,
      '1=1',
      '8',
      `cousub-${fips}.geojsonl`,
      'STATEFP,NAME,NAMELSAD,GEOID',
      false,
    )) {
      if (!record) throw new Error(`${code}: transform refused a town`);
      push(code, record, 'town');
    }
  }

  // **Assert the county counts, because the failure this file exists to fix was a MISSING row.**
  // New Hampshire was short by Rockingham and New York by ten, and nothing said so for a year.
  const short = Object.entries(EXPECTED_COUNTIES)
    .filter(([code, want]) => (counts.county?.[code] ?? 0) !== want)
    .map(([code, want]) => `${code}: ${counts.county?.[code] ?? 0} != ${want}`);
  if (short.length > 0) throw new Error(`county count mismatch — ${short.join(', ')}`);

  for (const { code } of STATES) {
    const rows = byState.get(code) ?? [];
    // **One file per state, because the loader stamps `state` from a single `--state=XX` flag.**
    // One combined file loaded five times would label New York as Maine four times over, and `state`
    // is denormalised onto every place label a user reads.
    writeFileSync(join(RAW, `areas-${code.toLowerCase()}.ndjson`), `${rows.join('\n')}\n`);
    const c = (l: string) => counts[l]?.[code] ?? 0;
    log(
      `${code}: ${rows.length} areas (${c('state')} state · ${c('county')} county · ${c('town')} town)`,
    );
  }
  log('load each with:');
  for (const { code } of STATES) {
    log(
      `  pnpm --filter @skating/admin-areas load .raw/areas-${code.toLowerCase()}.ndjson --state=${code}`,
    );
  }
}

try {
  main();
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
