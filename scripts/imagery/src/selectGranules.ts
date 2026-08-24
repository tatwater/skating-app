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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MAX_CLOUD_PCT, type GranuleCandidate, selectGranules } from './granuleSelection';

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

/** The mask file's own extent, via ogrinfo — see the module note for why this and not REGION_BOUNDS. */
function maskExtent(fgbPath: string): [number, number, number, number] {
  const out = execFileSync('ogrinfo', ['-so', '-al', fgbPath], { encoding: 'utf8' });
  const match = /Extent:\s*\(([-\d.]+),\s*([-\d.]+)\)\s*-\s*\(([-\d.]+),\s*([-\d.]+)\)/.exec(out);
  if (!match) throw new Error(`could not read an extent from ${fgbPath}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

interface StacItem {
  id: string;
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

  const maxCloudPct = Number(flag('cloud') ?? DEFAULT_MAX_CLOUD_PCT);

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
    const masks = flag('masks') ?? findLatestMasks();
    bbox = maskExtent(masks);
    console.error(`[select-granules] search box from ${masks}`);
  }
  console.error(
    `[select-granules] bbox ${bbox.join(', ')}  window ${from} → ${to}  cloud ≤ ${maxCloudPct}%`,
  );

  const candidates = await searchAll(bbox, from, to);
  const result = selectGranules(candidates, { maxCloudPct });

  mkdirSync(SCRATCH, { recursive: true });
  const outPath = flag('out') ?? join(SCRATCH, `granules-${from}-to-${to}.txt`);
  writeFileSync(outPath, `${result.selected.join('\n')}\n`);

  const { considered, selected, cloud, superseded, unparseable } = result.counts;
  console.error('');
  console.error(`[select-granules] considered  ${considered}`);
  console.error(`[select-granules] selected    ${selected}`);
  // Every drop is named. A selection step that reports only its output reads as "that is all there
  // was", and the whole cost argument here rests on knowing how much the gate refused.
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
