/**
 * `pnpm --filter @skating/seed-destinations seed [--apply] [--verify-imagery]` (A06c §2.3a / A06e §4).
 *
 * **Two commands, and the default is the safe one.** Without `--apply` this writes a reviewable
 * report and touches nothing — the founder asked to see the seed list before boosts go in, and the
 * ambiguous-match report needs somewhere to be read rather than being a console warning that
 * scrolls past.
 *
 * Reads the corpus through `waterBodies:listNamedForSeeding`, applies through
 * `waterBodies:setCuratedBoost` — the existing Phase 07 admin path, so a seeded boost is
 * indistinguishable from a hand-set one and lands in the same audit log the A06c §6.1 timeline renders.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  copernicusUrl,
  distanceToPolygonMeters,
  linkCoordinate,
  SATELLITE_MIN_AREA_SQM,
  satelliteImageryAvailable,
} from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import type { MultiPolygon, Polygon } from 'geojson';
import {
  boostFor,
  type CandidateBody,
  type CandidateSubArea,
  corroboration,
  DESTINATION_BOOST,
  type Destination,
  isSubArea,
  type MatchCandidate,
  matchAll,
} from './match';

const DEFAULT_SHORTLIST = fileURLToPath(new URL('../destinations.json', import.meta.url));
const REPORT = fileURLToPath(new URL('../.report.json', import.meta.url));
const IMAGERY_REPORT = fileURLToPath(new URL('../.imagery-report.json', import.meta.url));

/**
 * A06c §2.3a's proving run, moved here with the link it proves (D138) — **and it is not a link checker.**
 *
 * "Does the URL resolve" is the weakest question available: the Copernicus Browser is a single-page
 * app, so it answers 200 for any coordinate on earth, including ones in the middle of the Atlantic.
 * A green tick from that check would prove only that a hostname exists.
 *
 * The three things worth establishing before the link ships to 25,000 bodies, in the order they can
 * actually go wrong:
 *
 * 1. **Does the threshold gate the right lakes?** `SATELLITE_MIN_AREA_SQM` is a guess at where a 10 m
 *    pixel stops resolving a pond. If a name from the destination shortlist — lakes chosen precisely
 *    because people travel to skate them — comes back gated *off*, the constant is wrong, and that
 *    is the finding this run exists to surface.
 * 2. **Is the link built from a point on the water?** `linkCoordinate` prefers `interiorPoint` over
 *    the shoreline `centroid` (A06c-1), and a body still missing one opens the browser on its bank.
 * 3. **Is the host reachable at all**, checked once rather than per body — a rate-limit or an outage
 *    is a fact about the service, not about a lake.
 *
 * Everything lands in the report as URLs a human can click, because the last question — *is the
 * imagery legible at these sizes* — is the one no script can answer.
 */
async function verifyImageryLinks(matched: ReturnType<typeof matchAll>): Promise<void> {
  const rows = matched.flatMap((outcome) => {
    if (outcome.kind !== 'matched') return [];
    const target = outcome.target;
    // Sub-areas carry no `satelliteImagery` override and no imagery link of their own (A06e is
    // body-scoped) — a bay match here would either crash `linkCoordinate` or silently report on its
    // parent's imagery, which is not what the row claims. Skipped, not substituted.
    if (isSubArea(target)) return [];
    const body = target;
    const coord = linkCoordinate(body);
    const linked = satelliteImageryAvailable(body);
    return [
      {
        name: outcome.destination.name,
        state: outcome.destination.state,
        areaSqM: body.surfaceAreaSqM,
        // `on`/`off` are an operator's word; anything else is the area deciding.
        gatedOffByArea:
          !linked && body.satelliteImagery !== 'off' && (body.surfaceAreaSqM ?? 0) > 0,
        // The shoreline fallback is the failure that looks like success — a valid coordinate for the
        // wrong place. Champlain's two points are 30.7 km apart.
        pointIsShorelineFallback: !body.interiorPoint && Boolean(coord),
        url: coord && linked ? copernicusUrl(coord, Date.now()) : null,
      },
    ];
  });

  const gated = rows.filter((r) => r.gatedOffByArea);
  const shoreline = rows.filter((r) => r.pointIsShorelineFallback);

  let hostReachable: boolean | null = null;
  const sample = rows.find((r) => r.url)?.url;
  if (sample) {
    try {
      const response = await fetch(sample, { method: 'HEAD' });
      hostReachable = response.ok;
    } catch {
      hostReachable = false;
    }
  }

  writeFileSync(
    IMAGERY_REPORT,
    `${JSON.stringify({ threshold: SATELLITE_MIN_AREA_SQM, hostReachable, rows }, null, 2)}\n`,
  );

  process.stderr.write(
    `[seed] imagery: ${rows.length - gated.length}/${rows.length} destinations linked · ` +
      `host ${hostReachable === null ? 'unchecked' : hostReachable ? 'reachable' : 'UNREACHABLE'}\n` +
      `[seed] imagery report written to ${IMAGERY_REPORT}\n`,
  );
  // Named individually for the same reason unmatched destinations are: a *destination* the threshold
  // excludes is evidence about the threshold, and a count would let it pass as a statistic.
  for (const row of gated) {
    process.stderr.write(
      `[seed]   gated off (${Math.round((row.areaSqM ?? 0) / 10_000)} ha): ${row.name} (${row.state})\n`,
    );
  }
  for (const row of shoreline) {
    process.stderr.write(`[seed]   shoreline coordinate: ${row.name} (${row.state})\n`);
  }
}

/**
 * The matcher's third stage (see `resolveNearDistance`): the true distance from a corpus town to a
 * candidate's polygon, fetched **only** for the candidates the point and bbox tests could not decide
 * — a handful per run, never one per body (the paged reads deliberately omit polygons). A body's
 * outline comes from `waterBodies:get`; a sub-area's from its parent's `subAreas:listForBody`.
 * Cached per id. Returns undefined when the read fails, and the matcher then falls back to the bbox
 * and flags the outcome `bbox` so a reviewer sees it (Greptile, PR #69).
 */
function outlineDistanceResolver(): (
  candidate: MatchCandidate,
  near: { lat: number; lng: number },
) => number | undefined {
  const polygons = new Map<string, Polygon | MultiPolygon | null>();
  const fetchPolygon = (candidate: MatchCandidate): Polygon | MultiPolygon | null => {
    const cached = polygons.get(candidate._id);
    if (cached !== undefined) return cached;
    let polygon: Polygon | MultiPolygon | null = null;
    try {
      if (isSubArea(candidate)) {
        const rows = convexRun<{ _id: string; polygon: Polygon | MultiPolygon }[]>(
          'subAreas:listForBody',
          { waterBodyId: candidate.parentId },
        );
        polygon = rows.find((r) => r._id === candidate._id)?.polygon ?? null;
      } else {
        const result = convexRun<{
          available: boolean;
          body?: { polygon: Polygon | MultiPolygon };
        }>('waterBodies:get', { waterBodyId: candidate._id });
        polygon = result.body?.polygon ?? null;
      }
    } catch {
      polygon = null;
    }
    polygons.set(candidate._id, polygon);
    return polygon;
  };
  return (candidate, near) => {
    const polygon = fetchPolygon(candidate);
    if (!polygon) return undefined;
    return distanceToPolygonMeters(near, polygon) / 1000;
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  // `setCuratedBoost` is the admin path (moderator role): `--apply` runs it as the operator named by
  // `CONVEX_RUN_AS` (a Clerk user id with a moderator/admin profile on the target deployment).
  const runAs = process.env.CONVEX_RUN_AS;
  if (apply && !runAs) {
    process.stderr.write('[seed] --apply needs CONVEX_RUN_AS=<clerk user id of a moderator>\n');
    process.exit(2);
  }
  const verifyImagery = args.includes('--verify-imagery');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  // Lets a dry run point at an alternative shortlist (e.g. a corpus-derived one) without
  // touching the hand-curated `destinations.json` default.
  const inputArg = args.find((a) => a.startsWith('--input='))?.slice('--input='.length);
  const shortlistPath = inputArg
    ? fileURLToPath(new URL(inputArg, `file://${process.cwd()}/`))
    : DEFAULT_SHORTLIST;

  const destinations = JSON.parse(readFileSync(shortlistPath, 'utf8')) as Destination[];
  process.stderr.write(
    `[seed] ${destinations.length} destinations on the shortlist (${shortlistPath})\n`,
  );

  // Page the named corpus. Named-only, because a destination has a name by definition and the
  // unnamed 92% of the corpus can never match one — that filter is the difference between reading
  // a few thousand rows and reading all 24,948.
  const bodies: CandidateBody[] = [];
  let cursor: string | undefined;
  let isDone = false;
  while (!isDone) {
    const page = convexRun<{ bodies: CandidateBody[]; cursor: string; isDone: boolean }>(
      'waterBodies:listNamedForSeeding',
      cursor ? { cursor } : {},
    );
    bodies.push(...page.bodies);
    cursor = page.cursor;
    isDone = page.isDone;
  }
  process.stderr.write(`[seed] ${bodies.length} named bodies read\n`);

  // Page the sub-area table too (A02/A09 bays). It is small — dev holds ~120 rows total — but still
  // paged, the same discipline `listNamedForSeeding` uses for the corpus proper.
  const subAreas: CandidateSubArea[] = [];
  let subAreaCursor: string | undefined;
  let subAreasDone = false;
  while (!subAreasDone) {
    const page = convexRun<{ subAreas: CandidateSubArea[]; cursor: string; isDone: boolean }>(
      'subAreas:listNamedForSeeding',
      subAreaCursor ? { cursor: subAreaCursor } : {},
    );
    subAreas.push(...page.subAreas.map((s) => ({ ...s, kind: 'subArea' as const })));
    subAreaCursor = page.cursor;
    subAreasDone = page.isDone;
  }
  process.stderr.write(`[seed] ${subAreas.length} named sub-areas read\n`);

  const outcomes = matchAll(destinations, bodies, subAreas, {
    outlineDistanceKm: outlineDistanceResolver(),
  });
  const bboxBased = outcomes.filter((o) => o.kind === 'matched' && o.distanceBasis === 'bbox');
  if (bboxBased.length > 0) {
    process.stderr.write(
      `[seed] ⚠ ${bboxBased.length} match(es) rest on a bbox distance because the outline could not be fetched — review them\n`,
    );
  }
  const matched = outcomes.filter((o) => o.kind === 'matched');
  const ambiguous = outcomes.filter((o) => o.kind === 'ambiguous');
  const unmatched = outcomes.filter((o) => o.kind === 'unmatched');
  const matchedSubAreas = matched.filter((o) => o.kind === 'matched' && isSubArea(o.target));

  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        matched: matched.map((o) => {
          if (o.kind !== 'matched') return null;
          const target = o.target;
          return {
            name: o.destination.name,
            state: o.destination.state,
            kind: isSubArea(target) ? ('subArea' as const) : ('body' as const),
            targetId: target._id,
            targetName: target.name,
            ...(isSubArea(target)
              ? { parentId: target.parentId, parentName: target.parentName }
              : {}),
            distanceKm: o.distanceKm,
            distanceBasis: o.distanceBasis,
            corroboration: corroboration(o.destination),
            curatedBoost: boostFor(o.destination),
            alreadyBoosted: (target.curatedBoost ?? 0) !== 0,
          };
        }),
        ambiguous: ambiguous.map((o) =>
          o.kind === 'ambiguous'
            ? {
                name: o.destination.name,
                state: o.destination.state,
                candidates: o.candidates.map((c) => ({
                  _id: c._id,
                  name: c.name,
                  kind: isSubArea(c) ? ('subArea' as const) : ('body' as const),
                })),
              }
            : null,
        ),
        unmatched: unmatched.map((o) => ({ name: o.destination.name, state: o.destination.state })),
      },
      null,
      2,
    )}\n`,
  );

  if (verifyImagery) await verifyImageryLinks(matched);

  process.stderr.write(
    `[seed] ${matched.length} matched (${matchedSubAreas.length} sub-areas) · ` +
      `${ambiguous.length} ambiguous · ${unmatched.length} unmatched\n` +
      `[seed] report written to ${REPORT}\n`,
  );
  // **Named individually, not just counted.** An unmatched well-known lake means either a naming
  // mismatch or a genuine corpus gap, and both are a to-do rather than a statistic. The list is
  // short by construction.
  for (const o of unmatched) {
    process.stderr.write(`[seed]   unmatched: ${o.destination.name} (${o.destination.state})\n`);
  }
  for (const o of ambiguous) {
    if (o.kind !== 'ambiguous') continue;
    process.stderr.write(
      `[seed]   ambiguous: ${o.destination.name} (${o.destination.state}) — ${o.candidates.length} candidates\n`,
    );
  }

  if (!apply) {
    process.stderr.write('[seed] dry run. Review the report, then re-run with --apply.\n');
    return;
  }

  const logger = new RunLogger({
    kind: 'seed_destinations',
    label: 'curated destination boosts (A06c §2.3a/§4)',
    ...(campaignId ? { campaignId } : {}),
    target: resolveDeployment(),
    call: convexRun,
  });
  logger.start();

  let applied = 0;
  for (const o of matched) {
    if (o.kind !== 'matched') continue;
    const target = o.target;
    // **Never overwrite a boost a human already set.** A hand-set value is a judgment about a
    // specific lake; this list is a cold-start seed, and a seed that silently overrides curation is
    // the opposite of what D49 wants from it.
    if ((target.curatedBoost ?? 0) !== 0) {
      logger.fail({ stage: 'apply', key: o.destination.name, reason: 'already boosted by hand' });
      continue;
    }
    try {
      // Routed by table: a sub-area's boost goes through `subAreas:setCuratedBoost` (its own
      // moderator mutation, its own audit-log target type), never through the body mutation with a
      // sub-area id — the two tables' rows are not interchangeable ids.
      if (isSubArea(target)) {
        convexRun(
          'subAreas:setCuratedBoost',
          {
            subAreaId: target._id,
            curatedBoost: boostFor(o.destination),
          },
          { as: runAs },
        );
      } else {
        convexRun(
          'waterBodies:setCuratedBoost',
          {
            waterBodyId: target._id,
            curatedBoost: boostFor(o.destination),
          },
          { as: runAs },
        );
      }
      applied++;
    } catch (err) {
      logger.fail({
        stage: 'apply',
        key: o.destination.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.count('shortlist', destinations.length);
  logger.count('matched', matched.length);
  logger.count('matchedSubAreas', matchedSubAreas.length);
  logger.count('ambiguous', ambiguous.length);
  logger.count('unmatched', unmatched.length);
  logger.count('applied', applied);
  logger.coverage({
    covered: applied,
    eligible: destinations.length,
    unit: 'destinations',
    omissions: [
      ...(ambiguous.length
        ? [{ count: ambiguous.length, reason: 'ambiguous — needs a human' }]
        : []),
      ...(unmatched.length
        ? [{ count: unmatched.length, reason: 'no corpus body of that name' }]
        : []),
    ],
  });
  const uniformBoost = destinations.every(
    (d) => (d.curatedBoost ?? DESTINATION_BOOST) === DESTINATION_BOOST,
  );
  logger.succeed([
    uniformBoost
      ? `${applied} boosts applied at ${DESTINATION_BOOST}`
      : `${applied} boosts applied (graded per entry — see .report.json for the distribution)`,
  ]);
  process.stderr.write(`[seed] applied ${applied} boosts\n`);
}

main().catch((err) => {
  process.stderr.write(`[seed] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
