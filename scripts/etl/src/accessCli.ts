/**
 * The access ETL's transform stage (N6d B1/B2) — glue, so it is excluded from coverage; every rule it
 * applies lives in `./accessTransform` and `@skating/core`.
 *
 *   pnpm --filter @skating/etl access-transform                       # all five states
 *   pnpm --filter @skating/etl access-transform VT                    # one
 *   pnpm --filter @skating/etl access-transform --refresh             # re-run osmium
 *   pnpm --filter @skating/etl access-transform --no-route            # skip ORS entirely
 *   pnpm --filter @skating/etl access-transform --parking-radius=400  # eyeball a different radius
 *
 * Writes `.scratch/access/parking.ndjson` and `.scratch/access/put-ins.ndjson`, plus a
 * `summary.json` for the loader to fold into its `importRuns` row (N6c F2). **Two files rather than
 * one**, because a put-in references its lot by OSM id and the loader has to have inserted the lot
 * before it can resolve that — a mixed stream would work only until a pair straddled a batch
 * boundary, which is a bug that shows up once at scale and never in a fixture.
 *
 * ## The ORS stage, and why it is here rather than in the loader
 *
 * D87 routes the approach with `foot-hiking` on Phase 4's existing key. The quota is a non-issue
 * **because of when we call it**: once per paired put-in, at ETL time, cached on disk and then on the
 * row. Never from a request path — that is the one rule worth writing at the call site, and it is
 * written at this one.
 *
 * The routing runs *here* because the pairs exist here: parking-to-put-in is an OSM-to-OSM question
 * that needs no corpus (kickoff correction 3). Doing it after the load would mean querying the pairs
 * back out of Convex to route them and patching the rows afterwards — three round trips for a number
 * we already had everything to compute.
 *
 * **The response cache is the resumability story.** A full pass is thousands of serialized requests
 * against a free tier; a crash at request 3,000 must not re-spend the first 2,999. Keyed on the
 * coordinate pair, so it survives a re-run at a different `--parking-radius` for every pair the change
 * did not affect.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type ApproachLeg,
  type LatLng,
  ORS_FOOT_HIKING_URL,
  type OrsRouteResponse,
  orsFootHikingBody,
  PARKING_INFER_RADIUS_M,
  parseOrsFootHikingRoute,
  straightLineApproach,
} from '@skating/core';
import {
  type AccessFeature,
  type OsmAccessFeature,
  pairAccessFeatures,
  parseAccessFeature,
} from './accessTransform';
import { osmAccessExportArgs, osmAccessFilterArgs } from './extract';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OSM_DIR = join(ROOT, '.raw');
const SCRATCH = join(ROOT, '.scratch', 'access');
const ROUTE_CACHE = join(SCRATCH, 'ors-cache.json');

const ALL_STATES = ['vt', 'nh', 'me', 'ma', 'ny'] as const;

/** RFC 8142 record separator (U+001E) — `geojsonseq` may prefix each line with it. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function log(message: string): void {
  process.stderr.write(`[access] ${message}\n`);
}

/**
 * ORS's free tier is rate-limited per minute as well as per day. Serialized with a gap rather than
 * parallelized with a retry: this pass has no deadline, and the failure mode of hammering a free
 * endpoint is losing the key for everything else Phase 4 depends on.
 */
const ORS_GAP_MS = 700;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read `.env.local` beside this package, the `wind-climate` pattern. Real env wins. */
function readEnvFile(url: URL): Record<string, string> {
  if (!existsSync(fileURLToPath(url))) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(fileURLToPath(url), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Extract one state's access features, cached in `.scratch`. */
function accessFeatureFile(state: string, refresh: boolean): string {
  const out = join(SCRATCH, `osm-access-${state}.geojsonseq`);
  if (existsSync(out) && !refresh) return out;

  const dir = join(OSM_DIR, state);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${state}: no archived extract at ${dir}. Run \`pnpm --filter @skating/etl archive ${state.toUpperCase()}\` first — this pass deliberately reuses the water pass's pinned .pbf rather than downloading its own.`,
    );
  }
  const { filename } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { filename: string };

  const filtered = join(SCRATCH, `osm-access-${state}.pbf`);
  log(`${state}: filtering access features…`);
  const step1 = spawnSync('osmium', osmAccessFilterArgs(join(dir, filename), filtered), {
    encoding: 'utf8',
  });
  if (step1.status !== 0) throw new Error(`${state}: osmium tags-filter exited ${step1.status}`);

  const step2 = spawnSync('osmium', osmAccessExportArgs(filtered, out), { encoding: 'utf8' });
  if (step2.status !== 0) throw new Error(`${state}: osmium export exited ${step2.status}`);
  return out;
}

async function readAccessFeatures(states: readonly string[], refresh: boolean) {
  // The five extracts overlap at every border, so the same OSM id appears in two files. Deduped on
  // the id rather than the coordinate: the two copies are the same feature and may carry different
  // tag completeness, and taking the first is as good as any rule so long as it is one rule.
  const seen = new Set<string>();
  const features: AccessFeature[] = [];
  let refusedLines = 0;

  for (const state of states) {
    const file = accessFeatureFile(state, refresh);
    let kept = 0;
    const reader = createInterface({
      input: createReadStream(file, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const raw of reader) {
      const trimmed = raw.trim();
      const line = trimmed.startsWith(RECORD_SEPARATOR) ? trimmed.slice(1) : trimmed;
      if (line.length === 0) continue;
      let feature: OsmAccessFeature;
      try {
        feature = JSON.parse(line) as OsmAccessFeature;
      } catch {
        refusedLines++;
        continue;
      }
      const parsed = parseAccessFeature(feature);
      if (!parsed || seen.has(parsed.externalId)) continue;
      seen.add(parsed.externalId);
      features.push(parsed);
      kept++;
    }
    log(`${state}: ${kept} access features`);
  }
  return { features, refusedLines };
}

type RouteCache = Record<string, { meters: number; ascentM?: number; routed: boolean }>;

function cacheKey(from: LatLng, to: LatLng): string {
  const r = (n: number) => n.toFixed(5);
  return `${r(from.lat)},${r(from.lng)}|${r(to.lat)},${r(to.lng)}`;
}

async function routeApproach(
  from: LatLng,
  to: LatLng,
  apiKey: string | undefined,
): Promise<ApproachLeg> {
  if (!apiKey) return straightLineApproach(from, to);
  try {
    const res = await fetch(ORS_FOOT_HIKING_URL, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(orsFootHikingBody(from, to)),
    });
    if (!res.ok) {
      // A 404 here is ORS saying "no routable path", which is the B4 caveat arriving in a different
      // form and is not an error. Anything else is worth seeing, but never worth aborting a pass
      // over: one unroutable pair should cost that pair its precision, not the run its progress.
      if (res.status !== 404) log(`ORS ${res.status} for ${cacheKey(from, to)} — falling back`);
      return straightLineApproach(from, to);
    }
    return (
      parseOrsFootHikingRoute((await res.json()) as OrsRouteResponse) ??
      straightLineApproach(from, to)
    );
  } catch (err) {
    log(`ORS threw for ${cacheKey(from, to)} (${String(err)}) — falling back`);
    return straightLineApproach(from, to);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const noRoute = args.includes('--no-route');
  const radiusArg = args.find((a) => a.startsWith('--parking-radius='));
  const parkingRadius = radiusArg
    ? Number.parseFloat(radiusArg.slice('--parking-radius='.length))
    : PARKING_INFER_RADIUS_M;
  const states = args.filter((a) => !a.startsWith('--')).map((s) => s.toLowerCase());
  const selected = states.length > 0 ? states : [...ALL_STATES];

  mkdirSync(SCRATCH, { recursive: true });

  const { features, refusedLines } = await readAccessFeatures(selected, refresh);
  const pairing = pairAccessFeatures(features, parkingRadius);
  log(
    `paired at ${parkingRadius} m: ${pairing.putIns.length} put-ins (${pairing.stats.putInsWithParking} with parking), ${pairing.parking.length} lots (${pairing.stats.parkingWithoutPutIn} unpaired)`,
  );

  const env = { ...readEnvFile(new URL('../.env.local', import.meta.url)), ...process.env };
  const apiKey = noRoute ? undefined : env.ORS_API_KEY;
  if (!noRoute && !apiKey) {
    log('ORS_API_KEY not set — every approach falls back to straight-line, flagged as such (D87)');
  }

  const cache: RouteCache = existsSync(ROUTE_CACHE)
    ? (JSON.parse(readFileSync(ROUTE_CACHE, 'utf8')) as RouteCache)
    : {};
  const parkingById = new Map(pairing.parking.map((p) => [p.externalId, p]));
  const trailAt = new Set<string>();
  let routed = 0;
  let fellBack = 0;
  let cacheHits = 0;

  for (const putIn of pairing.putIns) {
    if (!putIn.parkingExternalId) continue;
    const lot = parkingById.get(putIn.parkingExternalId);
    if (!lot) continue;

    const key = cacheKey(lot.point, putIn.point);
    let leg = cache[key];
    if (leg) {
      cacheHits++;
    } else {
      leg = await routeApproach(lot.point, putIn.point, apiKey);
      cache[key] = leg;
      // Written every time rather than at the end: the whole value of the cache is surviving a crash
      // partway through a pass that costs thousands of requests.
      writeFileSync(ROUTE_CACHE, `${JSON.stringify(cache)}\n`);
      if (apiKey) await sleep(ORS_GAP_MS);
    }

    putIn.approachMeters = Math.round(leg.meters);
    putIn.approachAscentM = leg.ascentM === undefined ? undefined : Math.round(leg.ascentM);
    putIn.approachRouted = leg.routed;
    if (leg.routed) {
      routed++;
      // The trail amenity, derived rather than extracted (correction 9): ORS routes over the same
      // `highway=path` / `route=hiking` ways a second extract would have pulled, so a successful
      // foot-hiking leg IS the evidence a trail exists. A drive-up ramp routes over the car park's
      // own service road, so only a walk worth the name counts.
      if (leg.meters > 150) trailAt.add(lot.externalId);
    } else {
      fellBack++;
    }
  }

  for (const lot of pairing.parking) {
    if (trailAt.has(lot.externalId) && !lot.amenities.includes('trail')) {
      lot.amenities = [...lot.amenities, 'trail' as const].sort();
    }
  }

  const write = (name: string, rows: unknown[]) => {
    const path = join(SCRATCH, name);
    writeFileSync(path, rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');
    log(`wrote ${rows.length} → ${path}`);
  };
  write('parking.ndjson', pairing.parking);
  write('put-ins.ndjson', pairing.putIns);

  const summary = {
    states: selected,
    parkingRadiusM: parkingRadius,
    features: features.length,
    refusedLines,
    ...pairing.stats,
    routed,
    fellBackToStraightLine: fellBack,
    cacheHits,
    routingEnabled: Boolean(apiKey),
  };
  writeFileSync(join(SCRATCH, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(JSON.stringify(summary));
}

main().catch((err) => {
  process.stderr.write(`[access] ${String(err)}\n`);
  process.exit(1);
});
