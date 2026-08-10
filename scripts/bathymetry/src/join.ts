/**
 * Resolve every source lake to our water bodies, and cache the result (N6b).
 *
 *   pnpm --filter @skating/bathymetry join [--states=VT,NH] [--refresh]
 *
 * Calls `waterBodies:matchBathymetryLakes`, server-side because that is where the cell index lives.
 * Writes `.scratch/join/lakes.json`: the matched body's `externalId` (what tiles are stamped with),
 * its polygon (the shoreline constraint), and any bays the survey also covers, keyed by
 * `<source>:<lakeKey>`.
 *
 * **Not the same resolver as N6a's depth ETL**, though it was written to be. Placing a whole survey
 * and placing one depth reading want opposite answers when a lake's deepest point falls in one of its
 * bays — see `matchBathymetryLakes`. The first run of this ETL sent every acre of Moosehead Lake to
 * North Bay, and sent nothing at all about it to the log.
 *
 * **The representative point is the deepest measurement, not a centroid**, and that is not a detail.
 * A centroid of soundings is not guaranteed to be *on the water*: a crescent or horseshoe lake puts
 * it on the headland in the middle, and the join then finds nothing — or worse, finds the pond on the
 * other side of that headland. This was found by watching a hand-rolled centroid join miss 4 of 6
 * real Maine lakes.
 *
 * **Reads through `lakeSources`, not its own page loop.** It used to carry a second copy of the
 * per-source reading, which meant Vermont's BioBase archive — a CSV inside a zip rather than an
 * ArcGIS lane — had no join at all, and the 66 densest lakes in the corpus were unreachable. One
 * reader also means one place where a key that holds two water bodies gets split, which it must be
 * *before* the join: one key resolves to one polygon, so an unsplit key sends the second pond's
 * geometry to be clipped against a shoreline miles away and it vanishes without an error.
 *
 * Untestable subprocess + file glue, excluded from coverage.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import process from 'node:process';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { SCRATCH_ROOT } from './cache';
import { buildCorpusIndex, type CorpusIndex, coveringBody, readCorpusBodies } from './corpusIndex';
import { type JoinCandidate, joinInBatches } from './joinQuery';
import { runJoinQuery } from './joinRunner';
import { readAllLakes } from './lakeSources';
import { type ArchivedLake, representativePoint, shapePoints, splitByBody } from './lakes';
import { crosswalkFromNdjson, crosswalkNhdId, type MidasEntry } from './midasCrosswalk';
import { isRekeyEligible, type PointAssignment, rekeyByBody } from './rekey';

const JOIN_DIR = pathJoin(SCRATCH_ROOT, 'join');
const JOIN_FILE = pathJoin(JOIN_DIR, 'lakes.json');
/**
 * The synthetic lakes D95's re-key produced — **and the reason they need a file at all**.
 *
 * `build.ts` composes its work list from `readAllLakes()` + `splitByBody`, i.e. from the ARCHIVES.
 * A re-keyed lake is not in any archive: it is a slice of one, cut against the corpus, and it exists
 * only inside the join's process. Without this the join would report *"293 recovered"*, the build
 * would look up keys like `870@way/1234`, find nothing, and the layer would draw **none of them** —
 * a lane that reports success and ships nothing.
 */
const REKEYED_FILE = pathJoin(JOIN_DIR, 'rekeyed-lakes.json');

/**
 * Lakes per query, optimistically.
 *
 * **Not a safe constant, and it isn't meant to be one.** A Convex function may read 16 MB in a single
 * execution, and each lake pulls every listed body near its point with polygons attached — so the
 * cost per lake ranges over three orders of magnitude between a farm pond and a point in the middle
 * of Champlain. `joinInBatches` splits any batch that trips the cap, which is what lets this be sized
 * for the common case instead of for the worst one.
 */
const BATCH = 20;

export interface JoinedLake {
  externalId?: string;
  waterBodyId: string;
  name: string;
  state: string;
  polygon?: unknown;
  /**
   * Bays of the surveyed lake — bodies nested inside it, largest first, omitted when there are none.
   *
   * The builder draws the survey once against the primary polygon and then re-clips those lines to
   * each of these, so opening a bay shows the bay's share of its lake's basin rather than nothing.
   */
  alsoCovers?: { externalId?: string; waterBodyId: string; name: string; polygon?: unknown }[];
  /**
   * Whether the publisher's crosswalk agreed with the geometry, where an id was sent (N7-3).
   *
   * ⚠ **This was computed and then dropped on the first run**, because the record below is built
   * from an explicit field list and nobody added it — 2,463 rows, every one `undefined`, including
   * the 1,474 that carried an id. Reading that as "no disagreements" would have been a finding
   * about the writer rather than about Maine. Same shape as the wind lane fetching speed and
   * discarding it, and the same lesson: a measurement that reaches no artifact is not a measurement.
   */
  crosswalk?: 'confirmed' | 'promoted' | 'disagreed';
}

/** Disagreeing keys named in the log. Enough to recognise a pattern, small enough to read. */
const CROSSWALK_SAMPLE_CAP = 15;

function log(message: string): void {
  process.stderr.write(`[bathymetry] ${message}\n`);
}

/**
 * The archived MIDAS crosswalk, or an empty map.
 *
 * **Absent is a legitimate state, not an error.** Every non-Maine lane joins on geometry alone and
 * always has; a missing archive simply means the Maine lane does too. Failing here would make an
 * optional improvement a hard dependency of the whole layer.
 */
function readMidasCrosswalk(): Map<number, MidasEntry> {
  const path = pathJoin(SCRATCH_ROOT, '..', '.raw', 'me-midas-crosswalk', 'rows.ndjson');
  if (!existsSync(path)) return new Map();
  return crosswalkFromNdjson(readFileSync(path, 'utf8'));
}

export function lakeId(lake: ArchivedLake): string {
  return `${lake.sourceKey}:${lake.lakeKey}`;
}

/**
 * Measurements per lake sent to the containment gate.
 *
 * **A fixed sample, not the whole survey.** Vermont's densest lake carries 136,856 soundings and
 * Champlain 20,345; sending them would put hundreds of megabytes through a query whose read budget is
 * already the binding constraint. A containment *fraction* converges long before 64 points — the
 * decision it feeds is "most of this, or almost none of it", never a close call.
 */
const FOOTPRINT_SAMPLE = 64;

/**
 * An evenly-strided sample of a lake's own measurements.
 *
 * Strided rather than random, for two reasons that both matter more than sampling purity: a stride is
 * reproducible, so a re-run of the join produces the same verdicts as the run whose rejects someone
 * is reading; and source rows arrive grouped by transect, so a stride crosses every transect while
 * any contiguous slice would sample one line of a lake and call it the lake.
 */
export function sampleFootprint(
  points: readonly { lat: number; lng: number }[],
  limit = FOOTPRINT_SAMPLE,
): { lat: number; lng: number }[] {
  if (points.length <= limit) return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  const stride = points.length / limit;
  const out: { lat: number; lng: number }[] = [];
  for (let i = 0; i < limit; i += 1) {
    const p = points[Math.floor(i * stride)];
    if (p) out.push({ lat: p.lat, lng: p.lng });
  }
  return out;
}

/**
 * The merge's own corpus, which the re-key resolves against.
 *
 * Cross-package on purpose: this IS the artifact the campaign just loaded, so resolving against
 * anything else would mean the re-key and the corpus could disagree about which lakes exist.
 * `--corpus=<path>` overrides it.
 */
const CORPUS_NDJSON = pathJoin(
  SCRATCH_ROOT,
  '..',
  '..',
  'etl',
  '.scratch',
  'merge',
  'bodies.ndjson',
);

/**
 * Re-key every containment-rejected survey against corpus membership — **D95's lane** (N7-3).
 *
 * Rule 0 lives in the first line: only `isRekeyEligible` rejects get here, which is the containment
 * gate and nothing else. Everything downstream operates on measurements that some key claimed and
 * geography refused.
 *
 * Returns candidates for a **second ordinary join**, not admissions. The lane's job is to say which
 * lakes a bucket key was actually holding; whether each of those is a lake we will draw is still the
 * containment gate's decision, taken on the regrouped survey.
 */
export async function rekeyRejected(
  rejects: readonly { key: string; reason: string }[],
  byKey: ReadonlyMap<string, ArchivedLake>,
  corpus: CorpusIndex,
  log: (message: string) => void,
): Promise<{
  candidates: JoinCandidate[];
  lakes: ArchivedLake[];
  eligible: number;
  unmatched: number;
  bodiesTouched: number;
}> {
  const eligible = rejects.filter((r) => isRekeyEligible(r.reason));
  const candidates: JoinCandidate[] = [];
  const lakes: ArchivedLake[] = [];
  let unmatched = 0;
  let bodiesTouched = 0;
  if (eligible.length === 0) return { candidates, lakes, eligible: 0, unmatched, bodiesTouched };

  log(`re-key: ${eligible.length} containment reject(s) eligible (Rule 0)`);
  for (const reject of eligible) {
    const lake = byKey.get(reject.key);
    if (!lake) continue;
    const points = shapePoints(lake);
    if (points.length === 0) continue;
    // Every measurement, not a sample: the whole point is to know which body each one is in, and a
    // sample would place the groups it happened to hit and silently discard the rest.
    //
    // **Resolved locally, against the corpus the merge just wrote.** This used to be a server query
    // per point — batched, adaptively split around the 16 MB read cap, then fronted by a lookup grid
    // to cut the call count. It took 4+ hours on one key and the grid did nothing on the key that
    // matters (MIDAS 870: 16,191 measurements, 16,155 distinct cells) because those soundings are
    // scattered one per lake rather than dense within one. See `corpusIndex.ts`. Nothing here needs
    // the deployment: the lane only SPLITS a survey, and the ordinary join afterwards is what
    // resolves each part to a `waterBodyId`.
    const assignments: PointAssignment[] = points.map((p) => {
      const body = coveringBody(corpus, p);
      return body ? { externalId: body.externalId, name: body.name } : null;
    });
    const result = rekeyByBody(lake, assignments);
    log(
      `  re-key ${reject.key}: ${points.length} measurement(s) → ${result.bodiesTouched} bodies · ` +
        `${result.unmatched} in no body`,
    );
    unmatched += result.unmatched;
    bodiesTouched += result.bodiesTouched;
    for (const part of result.parts) {
      const point = representativePoint(part);
      if (!point) continue;
      const samplePoints = sampleFootprint(shapePoints(part));
      lakes.push(part);
      candidates.push({
        key: lakeId(part),
        point,
        ...(samplePoints.length > 0 ? { samplePoints } : {}),
      });
    }
  }
  return { candidates, lakes, eligible: eligible.length, unmatched, bodiesTouched };
}

/**
 * The re-keyed lakes, for the builder. Empty when the lane found nothing or never ran.
 *
 * Absent is a legitimate state — every run before N7-3 produced no such file — so this returns `[]`
 * rather than throwing, and the build simply has nothing extra to draw.
 */
export function readRekeyedLakes(): ArchivedLake[] {
  if (!existsSync(REKEYED_FILE)) return [];
  return JSON.parse(readFileSync(REKEYED_FILE, 'utf8')) as ArchivedLake[];
}

/** Read a cached join, for the builder and the sample renderer. */
export function readJoin(): Record<string, JoinedLake> {
  if (!existsSync(JOIN_FILE)) return {};
  return (JSON.parse(readFileSync(JOIN_FILE, 'utf8')) as { joined: Record<string, JoinedLake> })
    .joined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const states = args
    .find((a) => a.startsWith('--states='))
    ?.slice(9)
    .split(',')
    .map((s) => s.trim().toUpperCase());

  if (existsSync(JOIN_FILE) && !refresh) {
    log(`skip — ${JOIN_FILE} exists (pass --refresh to redo)`);
    return;
  }

  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  const logger = new RunLogger({
    kind: 'bathymetry_join',
    label: 'bathymetry join — archived lakes → corpus bodies',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'resolve',
        detail:
          'every archived source key resolved to a water body, split first so a key holding two ponds cannot match one polygon',
      },
    ],
  });
  logger.start();

  log('reading every archived source…');
  const all = (await readAllLakes()).filter((l) => !states || states.includes(l.state));

  // Split BEFORE the join. A key holding two ponds cannot be resolved to one polygon.
  const lakes = all.flatMap(splitByBody);
  const splits = lakes.length - all.length;
  if (splits > 0)
    log(`${splits} extra lake(s) from source keys that held more than one water body`);

  // **Every candidate carries a sample of its own measurements**, and that is the fix for the
  // quietest bug this ETL has had. The server's gate is conditional on this field being present; the
  // loop used to send nothing, so the gate never ran once across 2,491 lakes. The clearest casualties
  // were Caribou Lake's 28,250 acres of soundings published inside Ripogenus Lake's 1,798, and Fahi
  // Pond's 200 acres inside a 9-acre Mud Pond. Nothing threw, and a wrong basin renders exactly as
  // confidently as a right one.
  //
  // **Counting those casualties needs care, and a first attempt got it wrong.** Maine files some
  // lakes as several rows under one MIDAS — Moose Pond has five, three of them 0.0 acres — so taking
  // the first row per id compares a survey against a fragment and manufactures mismatches that are
  // not there. Aggregate the rows, or compare against the largest.
  //
  // It sends *points* rather than an area, and that took two attempts. An area derived from soundings
  // under-states its lake — they sample the interior — so the first version rejected 68 correct lakes
  // as thousand-fold mismatches, worst on Maine's sparse surveys. What the server can answer reliably
  // is "how much of this survey is inside that polygon", and that needs the points themselves.
  // **Maine's own MIDAS → NHD crosswalk**, where it is archived (N7-3). It resolves 5,611 of 5,803
  // MIDAS numbers and settles the one question geometry cannot: which of several adjacent bodies
  // the state meant. Absent archive → the join runs exactly as it did, which is why nothing here
  // fails when the file is missing.
  const crosswalk = readMidasCrosswalk();
  if (crosswalk.size > 0) log(`${crosswalk.size} MIDAS keys carry an NHD id (Maine crosswalk)`);
  else log('no MIDAS crosswalk archived — the Maine lane joins on geometry alone');

  const candidates: JoinCandidate[] = [];
  const noPoint: string[] = [];
  let crosswalkConfirmed = 0;
  const crosswalkPromoted: string[] = [];
  const crosswalkDisagreed: string[] = [];
  let keyed = 0;
  let unconfidentKey = 0;
  for (const lake of lakes) {
    const point = representativePoint(lake);
    if (!point) {
      noPoint.push(lakeId(lake));
      continue;
    }
    const samplePoints = sampleFootprint(shapePoints(lake));
    const resolved = crosswalkNhdId(lake, crosswalk);
    const nhdId = 'nhdId' in resolved ? resolved.nhdId : undefined;
    if ('nhdId' in resolved) keyed++;
    else if (resolved.skip === 'ambiguous' || resolved.skip === 'split-key') unconfidentKey++;
    candidates.push({
      key: lakeId(lake),
      point,
      ...(samplePoints.length > 0 ? { samplePoints } : {}),
      ...(nhdId !== undefined ? { nhdId } : {}),
    });
  }
  if (keyed > 0) {
    log(`  ${keyed} candidate(s) carry the publisher's NHD id`);
  }
  if (unconfidentKey > 0) {
    // One MIDAS number can hold two real lakes (9861 = Long Pond 651 ac + Lewiston Pond 24 ac).
    // Sending the larger would be a coin toss dressed as an id, so those go ungated instead.
    log(`  ${unconfidentKey} MIDAS key(s) map to more than one body — sent WITHOUT an id`);
  }
  const unsampled = candidates.filter((c) => c.samplePoints === undefined).length;
  if (unsampled > 0) {
    log(
      `  ⚠ ${unsampled} lake(s) carry no measurements to sample — the join runs ungated for them`,
    );
  }

  log(`resolving ${candidates.length} lakes, starting at ${BATCH} per query…`);
  const { matches, rejects } = await joinInBatches(
    candidates,
    BATCH,
    async (batch) => runJoinQuery(batch),
    (done, total) => {
      if (done % (BATCH * 10) < BATCH) log(`  ${done}/${total}`);
    },
  );

  // ── D95's re-key lane ─────────────────────────────────────────────────────
  //
  // Runs on the rejects and **only** on the rejects, and only on the ones the containment gate
  // refused — Rule 0. See `rekey.ts`: a key whose soundings land inside the body its own id resolves
  // to is finished, and China Lake is the fixture that says so.
  const byKey = new Map(lakes.map((l) => [lakeId(l), l]));
  const corpusPath =
    args.find((a) => a.startsWith('--corpus='))?.slice('--corpus='.length) ?? CORPUS_NDJSON;
  let rekeyed: Awaited<ReturnType<typeof rekeyRejected>> = {
    candidates: [],
    lakes: [],
    eligible: 0,
    unmatched: 0,
    bodiesTouched: 0,
  };
  if (rejects.some((r) => isRekeyEligible(r.reason))) {
    if (!existsSync(corpusPath)) {
      // Loud, not silent. Skipping the lane would look identical to "nothing was recoverable".
      log(`⚠ re-key SKIPPED — no corpus at ${corpusPath}. Run the merge, or pass --corpus=<path>.`);
    } else {
      const bodies = await readCorpusBodies(corpusPath);
      log(`re-key: indexing ${bodies.length.toLocaleString()} corpus bodies from ${corpusPath}`);
      rekeyed = await rekeyRejected(rejects, byKey, buildCorpusIndex(bodies), log);
    }
  }
  if (rekeyed.candidates.length > 0) {
    log(
      `re-key: ${rekeyed.eligible} containment reject(s) → ${rekeyed.candidates.length} lake(s) ` +
        `across ${rekeyed.bodiesTouched} bodies · ${rekeyed.unmatched} measurement(s) in no body`,
    );
    const second = await joinInBatches(
      rekeyed.candidates,
      BATCH,
      async (batch) => runJoinQuery(batch),
      (done, total) => {
        if (done % (BATCH * 10) < BATCH) log(`  re-key ${done}/${total}`);
      },
    );
    // **Through the ordinary gated join, not around it.** The lane regroups; it does not admit. A
    // re-keyed group that still fails containment is still a reject, and it is reported as one.
    log(`re-key: ${second.matches.length} recovered, ${second.rejects.length} still refused`);
    for (const lake of rekeyed.lakes) byKey.set(lakeId(lake), lake);
    matches.push(...second.matches);
    rejects.push(...second.rejects);
  }

  const joined: Record<string, JoinedLake> = {};
  let bays = 0;
  for (const m of matches) {
    const alsoCovers = (m.alsoCovers ?? []).map((b) => ({
      externalId: b.externalId,
      waterBodyId: b.waterBodyId,
      name: b.name,
      polygon: b.polygon,
    }));
    bays += alsoCovers.length;
    if (m.crosswalk === 'confirmed') crosswalkConfirmed++;
    else if (m.crosswalk === 'promoted') crosswalkPromoted.push(m.key);
    else if (m.crosswalk === 'disagreed') crosswalkDisagreed.push(m.key);
    joined[m.key] = {
      externalId: m.externalId,
      waterBodyId: m.waterBodyId,
      name: m.name,
      state: byKey.get(m.key)?.state ?? '',
      polygon: m.polygon,
      ...(alsoCovers.length > 0 ? { alsoCovers } : {}),
      ...(m.crosswalk ? { crosswalk: m.crosswalk } : {}),
    };
  }

  mkdirSync(JOIN_DIR, { recursive: true });
  writeFileSync(JOIN_FILE, JSON.stringify({ joined, rejects, noPoint }, null, 0));
  // Written even when empty, so a stale file from a previous run can never make a later build draw
  // lakes this run did not produce.
  writeFileSync(REKEYED_FILE, JSON.stringify(rekeyed.lakes, null, 0));

  // **The denominator has to include what the re-key added.** `candidates` is the count taken BEFORE
  // the lane ran, so measuring against it reported `2756/2491 (111%)` — a coverage figure over 100%,
  // which is always a denominator that moved rather than a result to celebrate. Same shape as the
  // depth join's `8,517 / 40,260` and the three others this campaign has corrected: report
  // `covered / inScope`, and let the re-keyed lakes into `inScope` because they were resolved too.
  const inScope = candidates.length + rekeyed.candidates.length;
  const pct = ((Object.keys(joined).length / Math.max(1, inScope)) * 100).toFixed(0);
  log(
    `✓ matched ${Object.keys(joined).length}/${inScope} (${pct}%)` +
      (rekeyed.candidates.length > 0
        ? ` — ${candidates.length} archived key(s) + ${rekeyed.candidates.length} re-keyed`
        : ''),
  );
  if (noPoint.length > 0) log(`  ${noPoint.length} lake(s) had no usable representative point`);
  if (bays > 0) log(`  ${bays} nested body/bodies also covered by a surveyed lake`);
  if (keyed > 0) {
    // **The crosswalk's own report card.** `agreed` means the state's id named a body the survey is
    // genuinely in and the promotion fired; `disagreed` means it named one the soundings are not in,
    // which is a finding about the key (MIDAS 870) or about our polygon, and is deliberately not
    // acted on. Named, not just counted — a disagreement you cannot look up is a number nobody works.
    log(
      `  crosswalk of ${keyed} keyed: ${crosswalkConfirmed} confirmed what geometry chose · ` +
        `${crosswalkPromoted.length} CORRECTED it · ${crosswalkDisagreed.length} disagreed`,
    );
    for (const key of crosswalkPromoted.slice(0, CROSSWALK_SAMPLE_CAP))
      log(`      corrected ${key}`);
    for (const key of crosswalkDisagreed.slice(0, CROSSWALK_SAMPLE_CAP))
      log(`      disagreed ${key}`);
  }

  // Group the rejections by kind. An ETL that silently matches 60% looks exactly like one that
  // matched all of it, so the shape of the misses is the output that matters most here.
  const kinds: Record<string, number> = {};
  for (const r of rejects) {
    const kind = r.reason.startsWith('no body here holds the survey')
      ? 'no body here holds the survey'
      : r.reason.startsWith('join failed')
        ? 'query failed'
        : r.reason;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    log(`  ${n} × ${kind}`);
  }

  // Every rejection itemized, not just tallied by kind — "412 × area mismatch" tells you the shape
  // of the problem, and only the named lakes tell you whether it is the right shape.
  for (const r of rejects) logger.fail({ stage: 'resolve', key: r.key, reason: r.reason });
  for (const key of noPoint) {
    logger.fail({
      stage: 'resolve',
      key,
      reason: 'no usable representative point in the source geometry',
    });
  }

  logger.count('archivedLakes', all.length);
  logger.count('afterSplit', lakes.length);
  logger.count('candidates', candidates.length);
  logger.count('matched', Object.keys(joined).length);
  logger.count('rejected', rejects.length);
  logger.count('noRepresentativePoint', noPoint.length);
  logger.count('nestedBodiesAlsoCovered', bays);
  logger.count('surveysWithNoSampledMeasurements', unsampled);
  logger.count('crosswalkKeyed', keyed);
  logger.count('crosswalkConfirmed', crosswalkConfirmed);
  logger.count('crosswalkCorrected', crosswalkPromoted.length);
  logger.count('crosswalkDisagreed', crosswalkDisagreed.length);
  logger.count('crosswalkUnusable', unconfidentKey);
  logger.coverage({
    unit: 'archived lakes',
    eligible: lakes.length,
    covered: Object.keys(joined).length,
    omissions: [
      ...Object.entries(kinds).map(([reason, count]) => ({ reason, count })),
      { reason: 'no usable representative point in the source geometry', count: noPoint.length },
    ].filter((o) => o.count > 0),
  });
  logger.stage({
    name: 'resolve',
    detail:
      'every archived source key resolved to a water body, split first so a key holding two ponds cannot match one polygon',
    output: JOIN_FILE,
    counts: [
      { name: 'candidates', value: candidates.length },
      { name: 'matched', value: Object.keys(joined).length },
      { name: 'rejected', value: rejects.length },
    ],
  });
  logger.succeed([
    `match rate ${pct}% (${Object.keys(joined).length}/${candidates.length})`,
    ...(splits > 0 ? [`${splits} extra lake(s) from source keys holding more than one body`] : []),
  ]);
}

if (process.argv[1]?.endsWith('join.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`[bathymetry] join failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
