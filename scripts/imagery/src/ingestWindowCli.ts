/**
 * Ask the observed weather whether the season has opened (N6e §C3 / D149).
 *
 *   pnpm --filter @skating/imagery ingest-window [--masks=<path.fgb>] [--days=92] [--sites=12]
 *
 * Prints the window and the `select-granules` invocation that follows from it. Deliberately does
 * *not* run the selection itself: the gate is a judgement about a season and the operator should see
 * it before a fan-out spends anything.
 *
 * ## Sites come from the mask file
 *
 * No new Convex query and no hardcoded coordinate list. The mask artifact already holds every corpus
 * body with its name, so the sentinel is found by name and the rest are sampled evenly across the
 * file — and because FlatGeobuf is Hilbert-ordered, an even stride through it is already spatially
 * spread rather than clustered in whichever county sorts first.
 *
 * ## Observed, never forecast
 *
 * D140's rule. `past_days` on Open-Meteo's forecast endpoint reaches right up to now, which is what
 * `packages/convex/convex/weather.ts` uses and for the same reason: the ERA5 archive lags ~5 days,
 * and a gate that cannot see the last five days is a gate that opens a week late.
 *
 * Thin glue over `ingestGate`; excluded from coverage, like the sibling CLIs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { ingestWindow, type SiteSeries } from './ingestGate';

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRATCH = join(HERE, '..', '.scratch');
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** Open-Meteo's forecast `past_days` ceiling — the same constant convex/weather.ts pins. */
const MAX_PAST_DAYS = 92;

/** The pond the community treats as the season opener (founder, 2026-08-21c). */
const SENTINEL_NAME = /lake of the clouds/i;

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

interface Site {
  siteId: string;
  lat: number;
  lng: number;
  sentinel: boolean;
}

/**
 * Sample sites out of the mask file.
 *
 * Reads `name` and a representative point per feature. `-geom=YES` would hand back every buffered
 * ring; `ST_PointOnSurface` via SQL keeps it to one coordinate each, which is all a temperature
 * lookup needs.
 */
function sampleSites(fgbPath: string, wanted: number): Site[] {
  const raw = execFileSync(
    'ogr2ogr',
    [
      '-f',
      'CSV',
      '/vsistdout/',
      fgbPath,
      '-dialect',
      'SQLite',
      '-sql',
      'SELECT name, ST_X(ST_PointOnSurface(geometry)) AS lng, ST_Y(ST_PointOnSurface(geometry)) AS lat FROM reveal_masks',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );

  const rows = raw.trim().split('\n').slice(1);
  const parsed: Site[] = [];
  for (const row of rows) {
    // Names contain commas ("Hall Pond, Upper"), so take the last two fields as the numbers.
    const parts = row.split(',');
    const lat = Number(parts[parts.length - 1]);
    const lng = Number(parts[parts.length - 2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = parts.slice(0, -2).join(',').replace(/^"|"$/g, '');
    parsed.push({
      siteId: name || `${lat.toFixed(3)},${lng.toFixed(3)}`,
      lat,
      lng,
      sentinel: false,
    });
  }

  const sentinel = parsed.find((s) => SENTINEL_NAME.test(s.siteId));
  if (sentinel) sentinel.sentinel = true;
  else
    console.error(
      '[ingest-window] ⚠ no "Lake of the Clouds" in the masks — running on the corpus signal alone',
    );

  // An even stride through a Hilbert-ordered file is already spatially spread.
  const others = parsed.filter((s) => !s.sentinel);
  const stride = Math.max(1, Math.floor(others.length / wanted));
  const sampled = others.filter((_, i) => i % stride === 0).slice(0, wanted);

  return sentinel ? [sentinel, ...sampled] : sampled;
}

/** One Open-Meteo call for every site — it takes comma-separated coordinate lists. */
async function fetchLows(sites: Site[], pastDays: number): Promise<SiteSeries[]> {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set('latitude', sites.map((s) => s.lat.toFixed(4)).join(','));
  url.searchParams.set('longitude', sites.map((s) => s.lng.toFixed(4)).join(','));
  url.searchParams.set('daily', 'temperature_2m_min');
  url.searchParams.set('past_days', String(Math.min(MAX_PAST_DAYS, pastDays)));
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timezone', 'UTC');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo ${response.status} ${response.statusText}`);
  const body = (await response.json()) as
    | { daily: { time: string[]; temperature_2m_min: (number | null)[] } }
    | { daily: { time: string[]; temperature_2m_min: (number | null)[] } }[];
  const blocks = Array.isArray(body) ? body : [body];

  return blocks.map((block, i) => {
    const site = sites[i] as Site;
    const days = block.daily.time
      .map((date, d) => ({ date, minTempC: block.daily.temperature_2m_min[d] }))
      .filter((d): d is { date: string; minTempC: number } => d.minTempC !== null);
    return { siteId: site.siteId, ...(site.sentinel ? { sentinel: true } : {}), days };
  });
}

function findLatestMasks(): string {
  if (!existsSync(SCRATCH)) throw new Error('no .scratch — run bake-masks first, or pass --masks=');
  const found = readdirSync(SCRATCH)
    .filter((f) => f.startsWith('masks-') && f.endsWith('.fgb'))
    .sort();
  const latest = found[found.length - 1];
  if (!latest) throw new Error('no mask file — run bake-masks first, or pass --masks=');
  return join(SCRATCH, latest);
}

async function main(): Promise<void> {
  const masks = flag('masks') ?? findLatestMasks();
  const pastDays = Number(flag('days') ?? MAX_PAST_DAYS);
  const wanted = Number(flag('sites') ?? 12);

  const sites = sampleSites(masks, wanted);
  console.error(`[ingest-window] ${sites.length} sites from ${masks}`);
  const sentinel = sites.find((s) => s.sentinel);
  if (sentinel) console.error(`[ingest-window] sentinel: ${sentinel.siteId}`);

  const series = await fetchLows(sites, pastDays);
  const window = ingestWindow(series);

  console.error('');
  if (!window.opensOn) {
    console.error(
      `[ingest-window] season has NOT opened in the last ${pastDays} days — nothing to ingest`,
    );
    return;
  }

  console.error(`[ingest-window] opened   ${window.opensOn}  (by ${window.openedBy.join(' + ')})`);
  // Printed because the two dates answer different questions and conflating them is the bug that
  // cost a whole simulated winter: `opened` is when we start looking, `winter` is when the region
  // actually froze, and only the second one can be followed by an ice-out.
  console.error(
    `[ingest-window] winter   ${window.winterFrom ?? 'not established — only the summit has frozen'}`,
  );
  console.error(`[ingest-window] closes   ${window.closesOn ?? 'still open'}`);
  console.error('');
  const to = window.closesOn ?? new Date().toISOString().slice(0, 10);
  console.error('[ingest-window] next:');
  console.error(
    `  pnpm --filter @skating/imagery select-granules --from=${window.opensOn} --to=${to}`,
  );
}

main().catch((error: unknown) => {
  console.error('[ingest-window] FATAL:', error instanceof Error ? error.message : error);
  process.exit(1);
});
