/**
 * Ask STAC which granules are worth cutting, and write the list a fan-out consumes (N6e PR 2).
 *
 *   pnpm --filter @skating/imagery select-granules --from=2026-01-01 --to=2026-03-15
 *     [--cloud=60] [--bbox=minLng,minLat,maxLng,maxLat] [--masks=<path.fgb>] [--out=<file>]
 *
 * ## This is the "which granules, when" that D148 keeps outside the container
 *
 * The container takes one granule id and knows nothing else; this decides *which* ids there are. That
 * separation is the condition attached to choosing Fly, and it is why this is a plain file of ids
 * rather than anything that talks to a Machines API.
 *
 * ## The search box comes from the masks, not from the map
 *
 * `REGION_BOUNDS` is the five states the *basemap* draws, and the corpus deliberately stops at I-84 —
 * so searching the map's extent would select granules over Long Island and the Catskills where we
 * hold no bodies at all. Those jobs are not wrong (the cutter exits 0 on "nothing to cut") but each
 * one boots a Machine to discover that, which is precisely the spend this whole selection step exists
 * to avoid.
 *
 * Reading the extent off the mask file instead makes the search **self-correcting**: extend the
 * corpus and the search widens with it, with nothing to remember to update.
 *
 * Thin glue over `granuleSelection`; excluded from coverage, like the sibling CLIs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertTileSurveyUsable,
  type GranuleCandidate,
  parseGranuleId,
  selectGranules,
} from './granuleSelection';
import {
  emptyTilesFromCollection,
  type TileSurveyCollection,
  type TileSurveyEntry,
  tileSurveyKey,
  toTileSurveyCollection,
} from './tileSurvey';

// `fileURLToPath`, never `new URL(...).pathname` — the latter is percent-encoded, so a checkout under
// a directory with a space in it resolves `.scratch` to a path that does not exist.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, '..', '.scratch');

const STAC_URL = process.env.STAC_URL ?? 'https://earth-search.aws.element84.com/v1';
const STAC_COLLECTION = process.env.STAC_COLLECTION ?? 'sentinel-2-l2a';

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** The mask file's own extent, via ogrinfo — see the module note for why this and not REGION_BOUNDS. */
function maskExtent(fgbPath: string): [number, number, number, number] {
  const out = execFileSync('ogrinfo', ['-so', '-al', fgbPath], { encoding: 'utf8' });
  const match = /Extent:\s*\(([-\d.]+),\s*([-\d.]+)\)\s*-\s*\(([-\d.]+),\s*([-\d.]+)\)/.exec(out);
  if (!match) throw new Error(`could not read an extent from ${fgbPath}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

interface StacItem {
  id: string;
  geometry?: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  properties: { datetime: string; 'eo:cloud_cover'?: number };
}

/**
 * A cap on how far a `next` chain may be followed.
 *
 * A season is a handful of pages at 250 items each. 200 is far beyond any real search and exists
 * only so that a server handing back a `next` link identical to the request that produced it turns
 * into an error rather than a loop nobody is watching.
 */
const MAX_STAC_PAGES = 200;

/**
 * Page through a STAC search.
 *
 * STAC caps a page at a few hundred items and hands back a `next` link. A season across ~25 tiles is
 * comfortably more than one page, and silently taking only the first would look exactly like a quiet
 * season — the failure this whole file exists to make loud.
 *
 * ⚠ **A `next` link comes in two shapes and only one of them carries a `body`.** Earth Search's POST
 * search returns the continuation token inside `body`; the GET form puts it in the `href` instead.
 * Treating an absent `body` as "no more pages" reads the second shape as the end of the search — the
 * quiet truncation this function is supposed to prevent, arriving through the door left open for it.
 * So the request shape follows the link rather than being assumed.
 */
async function searchAll(
  bbox: [number, number, number, number],
  from: string,
  to: string,
): Promise<GranuleCandidate[]> {
  const items: GranuleCandidate[] = [];
  let request: { url: string; body: Record<string, unknown> | null } | null = {
    url: `${STAC_URL}/search`,
    body: {
      collections: [STAC_COLLECTION],
      bbox,
      datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
      limit: 250,
    },
  };
  let pages = 0;

  while (request) {
    const response = request.body
      ? await fetch(request.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        })
      : await fetch(request.url);
    if (!response.ok)
      throw new Error(`STAC search failed: ${response.status} ${response.statusText}`);
    const page = (await response.json()) as {
      features: StacItem[];
      links?: { rel: string; href: string; body?: Record<string, unknown> }[];
    };
    pages++;
    for (const feature of page.features) {
      items.push({
        id: feature.id,
        datetime: feature.properties.datetime,
        ...(feature.properties['eo:cloud_cover'] === undefined
          ? {}
          : { cloudCoverPct: feature.properties['eo:cloud_cover'] }),
        ...(feature.geometry
          ? { footprint: feature.geometry as GranuleCandidate['footprint'] }
          : {}),
      });
    }
    const next = page.links?.find((l) => l.rel === 'next');
    if (!next) break;
    if (pages >= MAX_STAC_PAGES) {
      throw new Error(
        `STAC still offering a next link after ${pages} pages — refusing to keep following it`,
      );
    }
    request = { url: next.href, body: next.body ?? null };
  }

  console.error(`[select-granules] ${items.length} items across ${pages} STAC page(s)`);
  return items;
}

async function main(): Promise<void> {
  const from = flag('from');
  const to = flag('to');
  if (!from || !to) {
    console.error('usage: select-granules --from=YYYY-MM-DD --to=YYYY-MM-DD [--cloud=60]');
    console.error('  the window is D149 ingest gate territory — see the phase doc §C3');
    process.exit(64);
  }

  // No default (founder, 2026-08-24): we cut and store everything, so a later re-derivation never has
  // to go back to Copernicus. `--cloud=60` still gates when a cheap experiment wants one.
  const cloudFlag = flag('cloud');
  const maxCloudPct = cloudFlag === undefined ? undefined : Number(cloudFlag);

  const masksPath = flag('masks') ?? findLatestMasks();

  let bbox: [number, number, number, number];
  const explicit = flag('bbox');
  if (explicit) {
    const parts = explicit.split(',').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      console.error('--bbox wants minLng,minLat,maxLng,maxLat');
      process.exit(64);
    }
    bbox = parts as [number, number, number, number];
  } else {
    bbox = maskExtent(masksPath);
    console.error(`[select-granules] search box from ${masksPath}`);
  }
  console.error(
    `[select-granules] bbox ${bbox.join(', ')}  window ${from} → ${to}  cloud ≤ ${maxCloudPct}%`,
  );

  const candidates = await searchAll(bbox, from, to);

  // Which MGRS tiles hold no corpus body at all — measured once per tile against the mask file, not
  // per granule. A season spans ~100 tiles and ~9,000 granules, so this is ~100 cheap local reads
  // that remove ~44% of the Machines a backfill would otherwise boot only to exit 0.
  const emptyTiles = flag('bbox')
    ? undefined
    : findEmptyTiles(candidates, masksPath, { resurvey: has('resurvey') });

  const result = selectGranules(candidates, {
    ...(maxCloudPct === undefined ? {} : { maxCloudPct }),
    ...(emptyTiles === undefined ? {} : { emptyTiles }),
  });

  mkdirSync(SCRATCH, { recursive: true });
  const outPath = flag('out') ?? join(SCRATCH, `granules-${from}-to-${to}.txt`);
  writeFileSync(outPath, `${result.selected.join('\n')}\n`);

  const { considered, selected, cloud, superseded, unparseable } = result.counts;
  console.error('');
  console.error(`[select-granules] considered  ${considered}`);
  console.error(`[select-granules] selected    ${selected}`);
  // Every drop is named. A selection step that reports only its output reads as "that is all there
  // was", and the whole cost argument here rests on knowing how much the gate refused.
  console.error(`[select-granules] empty tile  ${result.counts.emptyTile}`);
  console.error(`[select-granules] too cloudy  ${cloud}`);
  console.error(`[select-granules] superseded  ${superseded}`);
  if (unparseable) console.error(`[select-granules] unparseable ${unparseable}`);
  if (considered > 0) {
    console.error(
      `[select-granules] the gate refused ${((cloud / considered) * 100).toFixed(1)}% of the window`,
    );
  }
  console.error('');
  console.error(`[select-granules] wrote ${outPath}`);
  if (selected > 0) console.error(`[select-granules] next:  ./fan-out.sh ${outPath}`);
}

/**
 * Which MGRS tiles contain no corpus body at all.
 *
 * ## Why per tile and not per granule
 *
 * A tile is a fixed patch of ground — every granule sharing an MGRS code covers the same square — so
 * emptiness is a property of the tile, tested once, not of the ~90 granules a season puts through it.
 * One season is ~9,000 granules across ~100 tiles, which turns 9,000 spatial queries into 100.
 *
 * ## The footprint's bounding box, and why over-inclusion is the safe error here
 *
 * `ogrinfo` has no `-clipsrc` — that is an `ogr2ogr` flag — so the test is `-spat` against the
 * footprint's bounding box rather than the rotated polygon itself.
 *
 * That is deliberately the *generous* direction. A bbox covers strictly more ground than the swath
 * inside it, so a tile this calls empty is genuinely empty, while a tile with bodies only in the
 * corners the swath misses is kept and costs one Machine that exits 0. The reverse error — calling a
 * populated tile empty — would mean a lake silently never receiving a photograph, which is the
 * failure nobody would notice.
 *
 * Failure is **not** treated as empty. A tile whose footprint cannot be read is left in, because the
 * cost of a wrong "empty" is a lake that silently never gets a photograph, while the cost of a wrong
 * "keep" is one Machine that exits 0.
 */
/** Bounding box of a footprint polygon, as `-spat` wants it: minX minY maxX maxY. */
function footprintBbox(
  footprint: NonNullable<GranuleCandidate['footprint']>,
): [number, number, number, number] {
  const polygons = footprint.type === 'Polygon' ? [footprint.coordinates] : footprint.coordinates;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const position of ring) {
        const x = position[0] as number;
        const y = position[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) throw new Error('footprint has no coordinates');
  return [minX, minY, maxX, maxY];
}

function findEmptyTiles(
  candidates: readonly GranuleCandidate[],
  masksPath: string,
  options: { resurvey: boolean },
): ReadonlySet<string> {
  // The cache key comes from the mask sidecar, so any corpus change invalidates it by construction.
  // No sidecar means no key, which means survey — never "assume the old answer still holds".
  const surveyPath = masksPath.replace(/\.fgb$/, '-tiles.geojson');
  const sidecarPath = masksPath.replace(/\.fgb$/, '.json');
  let expectedKey: string | null = null;
  try {
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as {
      season?: string;
      bodies?: number;
    };
    if (sidecar.season && typeof sidecar.bodies === 'number') {
      expectedKey = tileSurveyKey(sidecar.season, sidecar.bodies);
    }
  } catch {
    expectedKey = null;
  }

  if (!options.resurvey && expectedKey) {
    let cached: TileSurveyCollection | null = null;
    try {
      cached = JSON.parse(readFileSync(surveyPath, 'utf8')) as TileSurveyCollection;
    } catch {
      cached = null;
    }
    const fromCache = emptyTilesFromCollection(cached, expectedKey);
    if (fromCache) {
      console.error(
        `[select-granules] tile survey from cache — ${fromCache.size} tiles hold no corpus body`,
      );
      console.error(`[select-granules] inspect: ${surveyPath} (open in geojson.io or QGIS)`);
      return fromCache;
    }
  }
  type Footprint = NonNullable<GranuleCandidate['footprint']>;
  const perTile = new Map<string, Footprint>();
  for (const candidate of candidates) {
    const key = parseGranuleId(candidate.id);
    if (key && candidate.footprint && !perTile.has(key.tile)) {
      perTile.set(key.tile, candidate.footprint);
    }
  }

  const empty = new Set<string>();
  const entries: TileSurveyEntry[] = [];
  let unreadable = 0;
  for (const [tile, footprint] of perTile) {
    let count: number;
    try {
      const box = footprintBbox(footprint);
      const out = execFileSync('ogrinfo', ['-so', '-al', '-spat', ...box.map(String), masksPath], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      count = Number(/^Feature Count: (\d+)/m.exec(out)?.[1] ?? Number.NaN);
    } catch {
      count = Number.NaN;
    }
    if (Number.isNaN(count)) {
      unreadable++;
      continue;
    }
    if (count === 0) empty.add(tile);
    entries.push({ tile, bodies: count, kept: count > 0, bbox: footprintBbox(footprint) });
  }

  console.error(
    `[select-granules] ${perTile.size} tiles surveyed — ${empty.size} hold no corpus body` +
      (unreadable ? `, ${unreadable} unreadable (kept)` : ''),
  );

  // The decision lives in `granuleSelection` so it can be tested; this file is the I/O around it.
  // Checked BEFORE the artifact is written, so a broken survey is never cached as an authority.
  assertTileSurveyUsable({ surveyed: perTile.size, unreadable, empty: empty.size });

  if (expectedKey) {
    writeFileSync(
      surveyPath,
      `${JSON.stringify(toTileSurveyCollection(entries, expectedKey, new Date().toISOString()), null, 2)}\n`,
    );
    console.error(`[select-granules] wrote ${surveyPath} (open in geojson.io or QGIS)`);
  }

  return empty;
}

/**
 * The most recent mask bake in `.scratch`, so the common case needs no flags.
 *
 * Sorted by name rather than mtime: the names carry the season (`masks-winter-2026-27.fgb`) and sort
 * correctly, while mtime would prefer whichever file was last *touched* — which after a re-download
 * or a `cp -r` is not the newest season.
 */
function findLatestMasks(): string {
  if (!existsSync(SCRATCH)) {
    throw new Error('no .scratch — pass --masks=<path.fgb> or run bake-masks first');
  }
  const found = readdirSync(SCRATCH)
    .filter((f) => f.startsWith('masks-') && f.endsWith('.fgb'))
    .sort();
  const latest = found[found.length - 1];
  if (!latest) {
    throw new Error('no mask file in .scratch — pass --masks=<path.fgb> or run bake-masks first');
  }
  return join(SCRATCH, latest);
}

main().catch((error: unknown) => {
  console.error('[select-granules] FATAL:', error instanceof Error ? error.message : error);
  process.exit(1);
});
