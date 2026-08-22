/**
 * `pnpm --filter @skating/seed-destinations seed [--apply] [--verify-imagery]` (N6c B3a / N6e D).
 *
 * **Two commands, and the default is the safe one.** Without `--apply` this writes a reviewable
 * report and touches nothing — the founder asked to see the seed list before boosts go in, and the
 * ambiguous-match report needs somewhere to be read rather than being a console warning that
 * scrolls past.
 *
 * Reads the corpus through `waterBodies:listNamedForSeeding`, applies through
 * `waterBodies:setCuratedBoost` — the existing Phase 7 admin path, so a seeded boost is
 * indistinguishable from a hand-set one and lands in the same audit log the F1 timeline renders.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  copernicusUrl,
  linkCoordinate,
  SATELLITE_MIN_AREA_SQM,
  satelliteImageryAvailable,
} from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  type CandidateBody,
  corroboration,
  DESTINATION_BOOST,
  type Destination,
  matchAll,
} from './match';

const SHORTLIST = fileURLToPath(new URL('../destinations.json', import.meta.url));
const REPORT = fileURLToPath(new URL('../.report.json', import.meta.url));
const IMAGERY_REPORT = fileURLToPath(new URL('../.imagery-report.json', import.meta.url));

/**
 * B3a's proving run, moved here with the link it proves (D138) — **and it is not a link checker.**
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
 *    the shoreline `centroid` (N6c-1), and a body still missing one opens the browser on its bank.
 * 3. **Is the host reachable at all**, checked once rather than per body — a rate-limit or an outage
 *    is a fact about the service, not about a lake.
 *
 * Everything lands in the report as URLs a human can click, because the last question — *is the
 * imagery legible at these sizes* — is the one no script can answer.
 */
async function verifyImageryLinks(matched: ReturnType<typeof matchAll>): Promise<void> {
  const rows = matched.flatMap((outcome) => {
    if (outcome.kind !== 'matched') return [];
    const body = outcome.body;
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

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const verifyImagery = args.includes('--verify-imagery');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);

  const destinations = JSON.parse(readFileSync(SHORTLIST, 'utf8')) as Destination[];
  process.stderr.write(`[seed] ${destinations.length} destinations on the shortlist\n`);

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

  const outcomes = matchAll(destinations, bodies);
  const matched = outcomes.filter((o) => o.kind === 'matched');
  const ambiguous = outcomes.filter((o) => o.kind === 'ambiguous');
  const unmatched = outcomes.filter((o) => o.kind === 'unmatched');

  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        matched: matched.map((o) =>
          o.kind === 'matched'
            ? {
                name: o.destination.name,
                state: o.destination.state,
                bodyId: o.body._id,
                bodyName: o.body.name,
                distanceKm: o.distanceKm,
                corroboration: corroboration(o.destination),
                alreadyBoosted: (o.body.curatedBoost ?? 0) !== 0,
              }
            : null,
        ),
        ambiguous: ambiguous.map((o) =>
          o.kind === 'ambiguous'
            ? {
                name: o.destination.name,
                state: o.destination.state,
                candidates: o.candidates.map((c) => ({ _id: c._id, name: c.name })),
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
    `[seed] ${matched.length} matched · ${ambiguous.length} ambiguous · ${unmatched.length} unmatched\n` +
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
    label: 'curated destination boosts (N6c B3a/D)',
    ...(campaignId ? { campaignId } : {}),
    target: resolveDeployment(),
    call: convexRun,
  });
  logger.start();

  let applied = 0;
  for (const o of matched) {
    if (o.kind !== 'matched') continue;
    // **Never overwrite a boost a human already set.** A hand-set value is a judgement about a
    // specific lake; this list is a cold-start seed, and a seed that silently overrides curation is
    // the opposite of what D49 wants from it.
    if ((o.body.curatedBoost ?? 0) !== 0) {
      logger.fail({ stage: 'apply', key: o.destination.name, reason: 'already boosted by hand' });
      continue;
    }
    try {
      convexRun('waterBodies:setCuratedBoost', {
        waterBodyId: o.body._id,
        curatedBoost: DESTINATION_BOOST,
      });
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
  logger.succeed([`${applied} boosts applied at ${DESTINATION_BOOST}`]);
  process.stderr.write(`[seed] applied ${applied} boosts\n`);
}

main().catch((err) => {
  process.stderr.write(`[seed] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
