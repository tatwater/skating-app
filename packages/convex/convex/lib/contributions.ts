/**
 * Who contributed, read through the one rule (`contributionStands`, `@skating/core`; D253). Every
 * *contributors* figure reads these: the day's strip, the trailing week's `active_contributors`,
 * Metrics' week and first-timers. The season's walk (`seasonReach`) applies the same rule page by
 * page.
 *
 * Every read is an index range or an author's first rows, and bounded: the range reads share one
 * budget and say when it ran out (`capped`), and a person whose first rows of a kind are all
 * withdrawn — with no earlier contribution of another kind — reads as `unknown` rather than a guess.
 */

import { CONTRIBUTION_KINDS, type ContributionKind, contributionStands } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/**
 * The people with a standing contribution made in `[from, to)` — a report whose skate ended in it,
 * or anything else made in it — and whether the read stopped short.
 *
 * `cap` bounds the rows read across **every** kind together, not each: six kinds at the cap apiece
 * would be six times the transaction's read the caller sized it for, and a job that reads past
 * Convex's per-transaction limit fails whole rather than computing from a partial slice. Each kind
 * reads what the ones before it left, plus one row to tell whether it stopped short.
 *
 * `readReports` — the window's visible reports by skate end, when the caller has already read them
 * with `take(cap + 1)` — stand in for the first kind's read, so the same rows aren't read twice.
 */
export async function contributorsBetween(
  ctx: QueryCtx,
  from: number,
  to: number,
  cap: number,
  readReports?: readonly Doc<'reports'>[],
): Promise<{ people: Set<Id<'profiles'>>; capped: boolean }> {
  const people = new Set<Id<'profiles'>>();
  let left = cap;
  let capped = false;
  const within = async <T>(read: (n: number) => Promise<T[]>): Promise<T[]> => {
    const rows = await read(left + 1);
    if (rows.length > left) capped = true;
    const kept = rows.slice(0, left);
    left -= kept.length;
    return kept;
  };

  for (const r of await within((n) =>
    readReports !== undefined
      ? Promise.resolve(readReports.slice(0, n))
      : ctx.db
          .query('reports')
          .withIndex('by_moderation_and_skate_end_time', (q) =>
            q.eq('moderationStatus', 'visible').gte('skateEndTime', from).lt('skateEndTime', to),
          )
          .take(n),
  )) {
    if (contributionStands.report(r)) people.add(r.authorId);
  }
  for (const h of await within((n) =>
    ctx.db
      .query('hazards')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(n),
  )) {
    if (contributionStands.hazard(h)) people.add(h.createdByUserId);
  }
  for (const a of await within((n) =>
    ctx.db
      .query('accessAlerts')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(n),
  )) {
    if (contributionStands.accessAlert(a)) people.add(a.createdByUserId);
  }
  for (const f of await within((n) =>
    ctx.db
      .query('contentFlags')
      .withIndex('by_reason_created', (q) =>
        q.eq('reason', 'no_public_access').gte('createdAt', from).lt('createdAt', to),
      )
      .take(n),
  )) {
    if (contributionStands.noPublicAccess(f)) people.add(f.flaggerId);
  }
  for (const p of await within((n) =>
    ctx.db
      .query('putIns')
      .withIndex('by_source_created', (q) =>
        q.eq('source', 'official').gte('createdAt', from).lt('createdAt', to),
      )
      .take(n),
  )) {
    if (contributionStands.putIn(p) && p.createdByUserId !== undefined) {
      people.add(p.createdByUserId);
    }
  }
  for (const r of await within((n) =>
    ctx.db
      .query('waterBodyRequests')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(n),
  )) {
    if (contributionStands.corpusRequest(r)) people.add(r.requesterId);
  }
  return { people, capped };
}

/** How many of a person's first rows of each kind are looked through for one that stands. */
export const FIRST_PROBE = 10;

/**
 * What one kind's probe found: the instant of its first standing row; or, when the probe ran out on
 * rows that don't stand, the instant of the last row read — a standing one can only come at or after
 * it; or `null` when the person has no standing row of the kind at all.
 */
type Probe = { first: number } | { unseenFrom: number } | null;

/**
 * One kind's rows for a person, **in time order** (every index below ends in the instant `at`
 * reads), looked through until one stands or {@link FIRST_PROBE} rows have been read. Stopping at the
 * first that stands reads one row for nearly everyone, not the whole probe.
 */
async function probe<T>(
  rows: AsyncIterable<T>,
  at: (row: T) => number,
  stands: (row: T) => boolean,
): Promise<Probe> {
  let read = 0;
  for await (const row of rows) {
    if (stands(row)) return { first: at(row) };
    if (++read >= FIRST_PROBE) return { unseenFrom: at(row) };
  }
  return null;
}

/**
 * When `userId` first made a contribution that stands — the earliest across every kind — or `null`
 * if they never have.
 *
 * Each kind's first {@link FIRST_PROBE} rows are read in time order, the six kinds side by side.
 * When none of them stands, a standing one of that kind can only come at or after the last row
 * read; so the answer is `unknown` only when that instant is earlier than every standing
 * contribution found — a kind whose first rows are withdrawn can't move a first contribution already
 * known to come before them. Put-ins are read from those the person placed (`official`), never the
 * derived markers a moderator's hide is attributed to.
 */
export async function firstContributionAt(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
): Promise<number | null | 'unknown'> {
  const probes: Record<ContributionKind, Promise<Probe>> = {
    report: probe(
      ctx.db
        .query('reports')
        .withIndex('by_author_skate_end_time', (q) => q.eq('authorId', userId)),
      (r) => r.skateEndTime,
      contributionStands.report,
    ),
    hazard: probe(
      ctx.db
        .query('hazards')
        .withIndex('by_author_created', (q) => q.eq('createdByUserId', userId)),
      (h) => h.createdAt,
      contributionStands.hazard,
    ),
    // By `createdAt`, not `by_author`'s creation order: an alert's `createdAt` is when it was
    // observed, which an offline flush can backdate past alerts created before it.
    accessAlert: probe(
      ctx.db
        .query('accessAlerts')
        .withIndex('by_author_created', (q) => q.eq('createdByUserId', userId)),
      (a) => a.createdAt,
      contributionStands.accessAlert,
    ),
    noPublicAccess: probe(
      ctx.db
        .query('contentFlags')
        .withIndex('by_flagger_reason_created', (q) =>
          q.eq('flaggerId', userId).eq('reason', 'no_public_access'),
        ),
      (f) => f.createdAt,
      contributionStands.noPublicAccess,
    ),
    putIn: probe(
      ctx.db
        .query('putIns')
        .withIndex('by_created_by_source_created', (q) =>
          q.eq('createdByUserId', userId).eq('source', 'official'),
        ),
      (p) => p.createdAt,
      contributionStands.putIn,
    ),
    corpusRequest: probe(
      ctx.db
        .query('waterBodyRequests')
        .withIndex('by_requester_created', (q) => q.eq('requesterId', userId)),
      (r) => r.createdAt,
      contributionStands.corpusRequest,
    ),
  };
  let earliest: number | null = null;
  // The earliest instant a standing row past a full probe of withdrawn ones could have.
  let unseenFrom: number | null = null;
  for (const found of await Promise.all(CONTRIBUTION_KINDS.map((kind) => probes[kind]))) {
    if (found === null) continue;
    if ('first' in found) {
      earliest = earliest === null ? found.first : Math.min(earliest, found.first);
    } else {
      unseenFrom = unseenFrom === null ? found.unseenFrom : Math.min(unseenFrom, found.unseenFrom);
    }
  }
  if (unseenFrom !== null && (earliest === null || unseenFrom < earliest)) return 'unknown';
  return earliest;
}
