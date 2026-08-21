/**
 * The access ETL's transform stage (N6d B1/B2) — glue, so it is excluded from coverage; every rule it
 * applies lives in `./accessTransform` and `@skating/core`.
 *
 *   pnpm --filter @skating/etl access-transform                       # all five states
 *   pnpm --filter @skating/etl access-transform VT                    # one
 *   pnpm --filter @skating/etl access-transform --refresh             # re-run osmium
 *   pnpm --filter @skating/etl access-transform --no-route            # skip ORS entirely
 *   pnpm --filter @skating/etl access-transform --no-trails           # skip the connectivity pass
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
  approachPathWanted,
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
  applyTrailPairings,
  type OsmAccessFeature,
  pairAccessFeatures,
  parseAccessFeature,
} from './accessTransform';
import {
  osmAccessExportArgs,
  osmAccessFilterArgs,
  osmTrailExportArgs,
  osmTrailFilterArgs,
} from './extract';
import { createTrailGraphBuilder, pairByTrailConnectivity } from './trailGraph';

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
 * ORS's free tier caps **directions at 40 requests per minute**, and the first real run found that
 * out the hard way: at a 700 ms gap (~85/min) exactly 40 legs succeeded and the next 1,963 came back
 * `429`. 1,600 ms sits just under the ceiling.
 *
 * Serialized with a gap rather than parallelized with a retry: this pass has no deadline, and the
 * failure mode of hammering a free endpoint is losing the key for everything else Phase 4 depends on.
 */
const ORS_GAP_MS = 1_600;

/** How many times a rate-limited leg is retried before it gives up and flies straight. */
const ORS_MAX_RETRIES = 3;

/** Backoff after a 429. Generous — the limit is per minute, so waiting one out is the cheap fix. */
const ORS_BACKOFF_MS = 20_000;

/**
 * Consecutive `403`s that mean **the daily quota is gone**, not that one request was malformed.
 *
 * ORS signals per-minute throttling with `429` and daily exhaustion with **`403`** — which the first
 * full run discovered the expensive way: it hit the 2,000/day ceiling and then sent **2,978 more
 * requests**, every one of them refused, at 1.6 s apart. That is an hour and a half of politely
 * hammering an endpoint that had already said no, on somebody else's free tier.
 *
 * Three in a row is enough. A single 403 could be a bad payload for one odd coordinate pair; three
 * consecutive ones are a quota. After that the pass stops calling ORS entirely and flies the rest
 * straight — **uncached**, so tomorrow's run picks them up exactly where this one stopped.
 */
const ORS_QUOTA_STRIKES = 3;

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
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
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

/** Extract one state's trail lines, cached in `.scratch` (N6e Workstream 0). */
function trailFile(state: string, refresh: boolean): string {
  const out = join(SCRATCH, `osm-trails-${state}.geojsonseq`);
  if (existsSync(out) && !refresh) return out;

  const dir = join(OSM_DIR, state);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${state}: no archived extract at ${dir}. Run \`pnpm --filter @skating/etl archive ${state.toUpperCase()}\` first.`,
    );
  }
  const { filename } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { filename: string };

  const filtered = join(SCRATCH, `osm-trails-${state}.pbf`);
  log(`${state}: filtering trails…`);
  const step1 = spawnSync('osmium', osmTrailFilterArgs(join(dir, filename), filtered), {
    encoding: 'utf8',
  });
  if (step1.status !== 0) throw new Error(`${state}: osmium tags-filter exited ${step1.status}`);

  const step2 = spawnSync('osmium', osmTrailExportArgs(filtered, out), { encoding: 'utf8' });
  if (step2.status !== 0) throw new Error(`${state}: osmium export exited ${step2.status}`);
  return out;
}

/**
 * Stream every state's trail lines into one graph.
 *
 * **Streamed, one way at a time, and this is not a style preference.** Vermont alone is 40,840 ways
 * and 642k vertices; five states is on the order of 600–900k ways. Parsing them into an array of
 * GeoJSON features before building the graph would materialise the loose representation the compact
 * one exists to avoid, and the builder's whole point is that a way's coordinates are copied into a
 * `Float64Array` and the parsed object is left for the collector immediately.
 */
async function buildTrails(states: readonly string[], refresh: boolean) {
  const builder = createTrailGraphBuilder();
  let refusedLines = 0;

  for (const state of states) {
    const file = trailFile(state, refresh);
    let kept = 0;
    const reader = createInterface({
      input: createReadStream(file, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const raw of reader) {
      const trimmed = raw.trim();
      const line = trimmed.startsWith(RECORD_SEPARATOR) ? trimmed.slice(1) : trimmed;
      if (line.length === 0) continue;
      let feature: {
        properties?: { type?: string; id?: number };
        geometry?: { type?: string; coordinates?: number[][] };
      };
      try {
        feature = JSON.parse(line) as typeof feature;
      } catch {
        refusedLines++;
        continue;
      }
      const coordinates = feature.geometry?.coordinates;
      if (feature.geometry?.type !== 'LineString' || !coordinates) continue;
      const id = `${feature.properties?.type ?? 'way'}/${feature.properties?.id ?? ''}`;
      builder.addWay({
        id,
        coords: coordinates.map(([lng, lat]) => ({ lat: lat as number, lng: lng as number })),
      });
      kept++;
    }
    log(`${state}: ${kept} trail ways`);
  }

  const graph = builder.build();
  log(
    `trail graph: ${graph.stats.ways} ways, ${graph.stats.nodes} nodes, ${graph.stats.duplicates} cross-border duplicates, ${graph.stats.degenerate} degenerate`,
  );
  return { graph, refusedLines };
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

/**
 * A cached leg, plus **whether we have already asked for its line** (N6e Workstream 0).
 *
 * The flag exists because the geometry backfill has to be able to finish. N6d's parser read distance
 * and ascent off the ORS response and dropped `features[0].geometry`, so 4,945 legs were archived
 * without a line and the zero-cost window closed with the routing pass on 2026-08-13 — recovering
 * them means re-spending the quota, once, and never again.
 *
 * `pathAsked` is what makes "never again" true. A routed leg whose line came back unusable — over
 * `APPROACH_PATH_MAX_VERTICES` after simplification, or a response with no geometry at all — is a
 * **real answer**, so it is remembered, exactly like the 404 that says there is no path between two
 * points. Without the flag those legs would be re-requested on every run for ever, which is the
 * mirror image of the 429-cached-as-an-answer bug the first run found: that one cached a failure as
 * an answer, this one would refuse to cache an answer at all.
 */
type CachedLeg = ApproachLeg & { pathAsked?: boolean };

type RouteCache = Record<string, CachedLeg>;

function cacheKey(from: LatLng, to: LatLng): string {
  const r = (n: number) => n.toFixed(5);
  return `${r(from.lat)},${r(from.lng)}|${r(to.lat)},${r(to.lng)}`;
}

/**
 * A resolved leg, plus **whether the answer is worth remembering**.
 *
 * The distinction is the whole point, and the first real run is why it exists. A straight-line
 * fallback caused by a `429` is not an answer about this lake — it is an answer about how fast we
 * were asking — and caching it makes the damage permanent: the next run reads a stored
 * `routed: false`, skips the request, and the leg is never routed again however patient we are.
 * 2,173 legs were poisoned that way before this was fixed.
 *
 * A `404` is different. ORS genuinely has no path between these two points (an unmapped herd path
 * routes to nothing — the B4 caveat in another form), and that answer is stable, so it caches.
 */
interface RoutedLeg {
  leg: ApproachLeg;
  cacheable: boolean;
}

/** Flipped once the daily quota is provably gone; every later leg flies straight without asking. */
let quotaExhausted = false;
let consecutiveForbidden = 0;

async function routeApproach(
  from: LatLng,
  to: LatLng,
  apiKey: string | undefined,
): Promise<RoutedLeg> {
  if (quotaExhausted) return { leg: straightLineApproach(from, to), cacheable: false };
  // No key at all is a stable fact about this run, not a transient failure — but it is also not a
  // fact about the lake, so it is not written to an archive a keyed run will later read.
  if (!apiKey) return { leg: straightLineApproach(from, to), cacheable: false };

  for (let attempt = 0; attempt <= ORS_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(ORS_FOOT_HIKING_URL, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(orsFootHikingBody(from, to)),
      });

      if (res.status === 429) {
        // Per-minute cap. Waiting it out is the cheap fix; the daily cap is the one that ends a run,
        // and it ends it by exhausting these retries rather than by being detectable here.
        if (attempt < ORS_MAX_RETRIES) {
          log(`ORS 429 — backing off ${ORS_BACKOFF_MS / 1000}s (attempt ${attempt + 1})`);
          await sleep(ORS_BACKOFF_MS);
          continue;
        }
        log(`ORS 429 after ${ORS_MAX_RETRIES} retries for ${cacheKey(from, to)} — flying straight`);
        return { leg: straightLineApproach(from, to), cacheable: false };
      }

      if (res.status === 403) {
        // The daily quota, not a bad request — see `ORS_QUOTA_STRIKES`. Counted rather than logged
        // per leg, because the useful output is "we ran out", not 2,978 identical lines.
        consecutiveForbidden++;
        if (consecutiveForbidden >= ORS_QUOTA_STRIKES) {
          quotaExhausted = true;
          log(
            `ORS refused ${ORS_QUOTA_STRIKES} in a row with 403 — daily quota is gone. Flying the rest straight; re-run tomorrow and the cache resumes.`,
          );
        }
        return { leg: straightLineApproach(from, to), cacheable: false };
      }

      if (!res.ok) {
        // A 404 is "no routable path" and is a stable fact about these two points, so it caches.
        // Anything else is worth seeing and is not worth aborting a pass over: one bad pair should
        // cost that pair its precision, not the run its progress.
        consecutiveForbidden = 0;
        if (res.status !== 404) log(`ORS ${res.status} for ${cacheKey(from, to)} — falling back`);
        return { leg: straightLineApproach(from, to), cacheable: res.status === 404 };
      }

      consecutiveForbidden = 0;

      const parsed = parseOrsFootHikingRoute((await res.json()) as OrsRouteResponse);
      return parsed
        ? { leg: parsed, cacheable: true }
        : { leg: straightLineApproach(from, to), cacheable: true };
    } catch (err) {
      log(`ORS threw for ${cacheKey(from, to)} (${String(err)}) — falling back`);
      return { leg: straightLineApproach(from, to), cacheable: false };
    }
  }
  return { leg: straightLineApproach(from, to), cacheable: false };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const noRoute = args.includes('--no-route');
  const noTrails = args.includes('--no-trails');
  const radiusArg = args.find((a) => a.startsWith('--parking-radius='));
  const parkingRadius = radiusArg
    ? Number.parseFloat(radiusArg.slice('--parking-radius='.length))
    : PARKING_INFER_RADIUS_M;
  const states = args.filter((a) => !a.startsWith('--')).map((s) => s.toLowerCase());
  const selected = states.length > 0 ? states : [...ALL_STATES];

  mkdirSync(SCRATCH, { recursive: true });

  const { features, refusedLines } = await readAccessFeatures(selected, refresh);
  let pairing = pairAccessFeatures(features, parkingRadius);
  log(
    `paired at ${parkingRadius} m: ${pairing.putIns.length} put-ins (${pairing.stats.putInsWithParking} with parking), ${pairing.parking.length} lots (${pairing.stats.parkingWithoutPutIn} unpaired)`,
  );

  /**
   * The trail pass (N6e Workstream 0) — connectivity where proximity has already given up.
   *
   * Run **before** routing, deliberately: a pairing found here is indistinguishable downstream from
   * one found by proximity, so it goes through the same ORS leg and comes back with the same
   * distance, ascent and line. Running it after would leave exactly the longest approaches in the
   * corpus — the ones this pass exists to find — as the only unrouted ones.
   */
  let trailStats: Record<string, number> | undefined;
  if (!noTrails) {
    const { graph, refusedLines: refusedTrailLines } = await buildTrails(selected, refresh);
    const unpairedPutIns = pairing.putIns
      .filter((p) => !p.parkingExternalId)
      .map((p) => ({ externalId: p.externalId, point: p.point }));
    const unpairedLots = pairing.parking
      .filter((p) => !p.paired)
      .map((p) => ({ externalId: p.externalId, point: p.point }));

    const trails = pairByTrailConnectivity(graph, unpairedPutIns, unpairedLots);
    pairing = applyTrailPairings(pairing, trails.pairings);
    trailStats = {
      ...graph.stats,
      ...trails.stats,
      refusedTrailLines,
      trailPairings: trails.pairings.length,
    };
    log(
      `trails: ${trails.pairings.length} new pairings from ${trails.stats.putInsOnTrail}/${unpairedPutIns.length} unpaired launches on a trail and ${trails.stats.lotsOnTrail}/${unpairedLots.length} unpaired lots`,
    );
  }

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
  /** Legs that flew straight for a *transient* reason — the number a re-run will retry. */
  let uncached = 0;
  /** Hike-in legs re-requested purely to recover the line N6d's parser discarded. */
  let pathBackfills = 0;
  /** …of which came back with a usable line. */
  let pathsRecovered = 0;
  /** Hike-in legs still owed a line when this run ended — the operator's "run it again" number. */
  let awaitingPath = 0;

  for (const putIn of pairing.putIns) {
    if (!putIn.parkingExternalId) continue;
    const lot = parkingById.get(putIn.parkingExternalId);
    if (!lot) continue;

    const key = cacheKey(lot.point, putIn.point);
    let leg = cache[key];
    if (leg) {
      cacheHits++;
      // The geometry backfill (N6e Workstream 0). Only hike-in legs, because only they will be drawn
      // or buffered — `approachPathWanted` is the *same* predicate the parser keeps a line by, so a
      // leg can never be re-routed against the quota and then have its geometry thrown away.
      if (leg.routed && approachPathWanted(leg.meters) && !leg.path && !leg.pathAsked) {
        pathBackfills++;
        const refreshed = await routeApproach(lot.point, putIn.point, apiKey);
        if (refreshed.leg.routed) {
          // Replaced only on a routed answer. A transient straight-line fallback must never
          // overwrite a distance we already paid for — that would spend the quota to make the row
          // worse, and `approachRouted: false` would then render "at least" on a leg ORS had walked.
          leg = { ...refreshed.leg, pathAsked: true };
          cache[key] = leg;
          writeFileSync(ROUTE_CACHE, `${JSON.stringify(cache)}\n`);
          if (leg.path) pathsRecovered++;
        }
        if (apiKey) await sleep(ORS_GAP_MS);
      }
      // Retryable only. A leg already asked will never gain a line however many times we run, so
      // counting it here would leave the operator waiting on a number that cannot reach zero.
      if (leg.routed && approachPathWanted(leg.meters) && !leg.path && !leg.pathAsked) {
        awaitingPath++;
      }
    } else {
      const routedLeg = await routeApproach(lot.point, putIn.point, apiKey);
      // A leg routed *now* has been asked about its line by construction — the parser kept whatever
      // came back. Marking it here is what stops a fresh hike-in leg with an unusable line from
      // joining the backfill queue on the very next run.
      leg = routedLeg.leg.routed ? { ...routedLeg.leg, pathAsked: true } : routedLeg.leg;
      // **Only real answers are archived.** A rate-limited fallback is a fact about our request rate,
      // not about this lake, and storing it would make the next run skip the leg for ever.
      if (routedLeg.cacheable) {
        cache[key] = leg;
        // Written every time rather than at the end: the whole value of the cache is surviving a
        // crash partway through a pass that costs thousands of requests.
        writeFileSync(ROUTE_CACHE, `${JSON.stringify(cache)}\n`);
      } else {
        uncached++;
      }
      if (apiKey) await sleep(ORS_GAP_MS);
    }

    putIn.approachMeters = Math.round(leg.meters);
    putIn.approachAscentM = leg.ascentM === undefined ? undefined : Math.round(leg.ascentM);
    putIn.approachRouted = leg.routed;
    putIn.approachPath = leg.path;
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
    // Named apart from `fellBackToStraightLine`: this is the retryable half, and it is the number
    // that says whether re-running tomorrow is worth anything.
    retryableFallbacks: uncached,
    cacheHits,
    // The N6e Workstream 0 lane, reported apart from the routing counters because it is a different
    // question: routing asks "how far is the walk", this asks "do we have the line to draw it".
    pathBackfills,
    pathsRecovered,
    ...(trailStats ? { trails: trailStats } : {}),
    // Not a ratio (D137): the legs a re-run tomorrow would still pick up, named.
    legsAwaitingPath: awaitingPath,
    routingEnabled: Boolean(apiKey),
    // The operator's "come back tomorrow" signal, stated rather than inferred from a ratio.
    quotaExhausted,
  };
  writeFileSync(join(SCRATCH, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(JSON.stringify(summary));
}

main().catch((err) => {
  process.stderr.write(`[access] ${String(err)}\n`);
  process.exit(1);
});
