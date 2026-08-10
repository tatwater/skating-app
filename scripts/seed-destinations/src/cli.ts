/**
 * `pnpm --filter @skating/seed-destinations seed [--apply]` (N6c B3a / Workstream D).
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

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
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
