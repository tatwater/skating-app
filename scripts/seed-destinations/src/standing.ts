/**
 * `pnpm --filter @skating/seed-destinations seed-standing [--gazetteer=<csv>] [--apply]` (A07b).
 *
 * **The one-time partition of the stored corpus into active and dormant**, re-runnable after any
 * campaign. The rule is `standing:seedStanding`'s (evidence of access or use keeps a body active);
 * what this script adds is the founder's keep list — every lake the design corpus talks about
 * (`training_data/google_group/gazetteer.csv`, gitignored, 73 rows) plus the curated destination
 * shortlist, matched to corpus bodies by name and state exactly as the boost seed matches them.
 *
 * **Two commands, and the default is the safe one.** Without `--apply` this writes a reviewable
 * report — matched, ambiguous (a name with several same-named bodies in the state; the founder
 * picks), unmatched (a lake the corpus does not hold at all, which is a to-do for the request path)
 * — and pages the seed dry, printing what it *would* shelve. With `--apply` it shelves, recorded as
 * a `standing_seed` run row, and the finish schedules the weather-registry walk that prunes the
 * cells the shelved bodies vacated.
 *
 * An ambiguous match is deliberately NOT kept: keeping every candidate would keep the wrong pond
 * active on the strength of a name, which is the Phase-02b mistake this matcher exists to refuse.
 * Resolve them by hand in the lake editor's Standing card, or add a `near` coordinate to the
 * shortlist and re-run.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { type CandidateBody, type Destination, matchAll } from './match';
import { dedupeDestinations, gazetteerToDestinations, keepIdsFor } from './standingSeed';

const SHORTLIST = fileURLToPath(new URL('../destinations.json', import.meta.url));
const REPORT = fileURLToPath(new URL('../.standing-report.json', import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const gazetteerPath = args
    .find((a) => a.startsWith('--gazetteer='))
    ?.slice('--gazetteer='.length);
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);

  const shortlist = JSON.parse(readFileSync(SHORTLIST, 'utf8')) as Destination[];
  const gazetteer =
    gazetteerPath && existsSync(gazetteerPath)
      ? gazetteerToDestinations(readFileSync(gazetteerPath, 'utf8'))
      : [];
  if (gazetteerPath && gazetteer.length === 0) {
    throw new Error(`gazetteer: nothing read from ${gazetteerPath}`);
  }
  const destinations = dedupeDestinations([shortlist, gazetteer]);
  process.stderr.write(
    `[standing] keep list: ${shortlist.length} shortlist + ${gazetteer.length} gazetteer → ${destinations.length} distinct\n`,
  );

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
  process.stderr.write(`[standing] ${bodies.length} named bodies read\n`);

  const outcomes = matchAll(destinations, bodies);
  const matched = outcomes.filter((o) => o.kind === 'matched');
  const ambiguous = outcomes.filter((o) => o.kind === 'ambiguous');
  const unmatched = outcomes.filter((o) => o.kind === 'unmatched');
  const posterOnly = matched.filter((o) => o.kind === 'matched' && o.viaMentionedState);
  const keepIds = keepIdsFor(outcomes);

  // **The run row is opened before the first mutating page** (review, PR #61): every page commits
  // on its own, so a walk that dies at page 80 has shelved 4,000 bodies — and without a `running`
  // row nothing would say so, and the `standing_seed` finish that reconciles the vacated weather
  // cells would never fire. Dry runs get no row; they write nothing.
  const logger = apply
    ? new RunLogger({
        kind: 'standing_seed',
        label: 'corpus standing seed (A07b)',
        ...(campaignId ? { campaignId } : {}),
        target: resolveDeployment(),
        call: convexRun,
      })
    : null;
  logger?.start();

  // The seed itself, paged. Dry unless --apply; the tallies are identical either way.
  const totals = { scanned: 0, demoted: 0, kept: {} as Record<string, number> };
  let seedCursor: string | undefined;
  let seedDone = false;
  try {
    while (!seedDone) {
      const page = convexRun<{
        scanned: number;
        demoted: number;
        kept: Record<string, number>;
        cursor: string;
        isDone: boolean;
      }>('standing:seedStanding', {
        keepIds,
        ...(apply ? { apply: true } : {}),
        ...(seedCursor ? { cursor: seedCursor } : {}),
      });
      totals.scanned += page.scanned;
      totals.demoted += page.demoted;
      for (const [k, v] of Object.entries(page.kept)) totals.kept[k] = (totals.kept[k] ?? 0) + v;
      seedCursor = page.cursor;
      seedDone = page.isDone;
      process.stderr.write(`[standing] …${totals.scanned} scanned, ${totals.demoted} to shelve\r`);
    }
  } catch (err) {
    logger?.count('scanned', totals.scanned);
    logger?.count('demoted', totals.demoted);
    logger?.failed(err, [
      `Died after ${totals.scanned} bodies with ${totals.demoted} already shelved. Re-run: the seed is idempotent (a shelved body is counted, not re-shelved).`,
    ]);
    throw err;
  }
  process.stderr.write('\n');

  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        applied: apply,
        totals,
        matched: matched.map((o) =>
          o.kind === 'matched'
            ? {
                name: o.destination.name,
                state: o.destination.state,
                bodyId: o.body._id,
                ...(o.viaMentionedState ? { viaMentionedState: true, kept: false } : {}),
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
    `[standing] keep list: ${matched.length} matched (${posterOnly.length} via a poster state only — reported, not kept) · ${ambiguous.length} ambiguous · ${unmatched.length} unmatched\n` +
      `[standing] corpus: ${totals.scanned} scanned · ${totals.demoted} ${apply ? 'shelved' : 'would be shelved'} · kept ${JSON.stringify(totals.kept)}\n` +
      `[standing] report written to ${REPORT}\n`,
  );
  for (const o of unmatched) {
    process.stderr.write(
      `[standing]   unmatched: ${o.destination.name} (${o.destination.state})\n`,
    );
  }
  for (const o of ambiguous) {
    if (o.kind !== 'ambiguous') continue;
    process.stderr.write(
      `[standing]   ambiguous: ${o.destination.name} (${o.destination.state}) — ${o.candidates.length} candidates, NOT kept\n`,
    );
  }

  if (!apply || !logger) {
    process.stderr.write('[standing] dry run. Review the report, then re-run with --apply.\n');
    return;
  }

  logger.count('scanned', totals.scanned);
  logger.count('demoted', totals.demoted);
  for (const [k, v] of Object.entries(totals.kept)) logger.count(`kept.${k}`, v);
  logger.count('keepList.matched', matched.length);
  logger.count('keepList.ambiguous', ambiguous.length);
  logger.count('keepList.unmatched', unmatched.length);
  logger.coverage({
    covered: matched.length,
    eligible: destinations.length,
    unit: 'keep-list lakes',
    omissions: [
      ...(ambiguous.length
        ? [{ count: ambiguous.length, reason: 'ambiguous — needs a human, not kept' }]
        : []),
      ...(unmatched.length
        ? [{ count: unmatched.length, reason: 'no corpus body of that name' }]
        : []),
    ],
  });
  logger.succeed([`${totals.demoted} bodies shelved as inactive`]);
}

main().catch((err) => {
  process.stderr.write(`[standing] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
