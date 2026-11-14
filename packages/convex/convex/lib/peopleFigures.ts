/**
 * The People figures, read one way (B01 §5.7): the Overview's People card and the People lanes both
 * come through here, so a lane's count and the card's figure for it can't disagree.
 *
 * - **Stored lanes** (Everyone, Staff, Banned, Restricted, Leaving, Deleted) are `peopleCounts`, moved
 *   by the writer of `peopleRows` with the rows themselves — exact. Until the rows backfill has run
 *   they are floors and say so (`capped`).
 * - **Time-bound lanes** — Suspended (still running) and Newest (the last week) — are counted from the
 *   very index range the list pages through ({@link laneRange}), capped at {@link LANE_COUNT_CAP}.
 * - **Queue lanes** — Flagged and Appeals open — group the open queue each reads (open flags, waiting
 *   support tickets), so the lane's people and its count come from the same rows. Flagged means the
 *   person *or their content* (the founder, 2026-11-14), through each flag's stamped subject.
 */

import { COUNT_CAP, type Count, cappedCount, NEWEST_DAYS } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { flagSubject } from './flagSubject';
import { accountsTotal } from './metricReads';
import { readOpenFlags } from './openFlags';
import { OPEN_ENDED, READY_FLAG_SUBJECTS, READY_ROWS, type StoredCountKey } from './peopleRows';

const DAY_MS = 86_400_000;

/** A time-bound or queue lane counts this far, then reads "200+". */
export const LANE_COUNT_CAP = COUNT_CAP;

// ── Stored counts ──────────────────────────────────────────────────────────────────────────────

export interface StoredCounts {
  count: (key: StoredCountKey) => Count;
  /** Every profile has a row: the stored counts are exact, not floors. */
  rowsReady: boolean;
  /** Every flag carries its subject: a person's content flags are all found. */
  flagSubjectsReady: boolean;
}

/** The stored counts and markers — a handful of tiny rows. */
export async function readStoredCounts(ctx: QueryCtx): Promise<StoredCounts> {
  const rows = await ctx.db.query('peopleCounts').take(64);
  const byKey = new Map(rows.map((r) => [r.key, r.count]));
  const rowsReady = byKey.has(READY_ROWS);
  return {
    count: (key) => ({ count: Math.max(0, byKey.get(key) ?? 0), capped: !rowsReady }),
    rowsReady,
    flagSubjectsReady: byKey.has(READY_FLAG_SUBJECTS),
  };
}

// ── Time-bound lanes: one range for the list and its count ─────────────────────────────────────

/**
 * The index range a time-bound lane reads, in the lane's order:
 * - **suspended** — still running at `now`, soonest to lapse first, an open-ended one last. A lapsed
 *   suspension leaves the range the moment it lapses, whatever the stored status says until the sweep
 *   resets it.
 * - **newest** — accounts made in the last {@link NEWEST_DAYS} days, newest first, tombstones left out.
 */
export function laneRange(ctx: QueryCtx, lane: 'suspended' | 'newest', now: number) {
  if (lane === 'suspended') {
    return ctx.db
      .query('peopleRows')
      .withIndex('by_suspended_until', (q) => q.gt('suspendedUntil', now))
      .order('asc');
  }
  return ctx.db
    .query('peopleRows')
    .withIndex('by_live_created', (q) =>
      q.eq('live', true).gte('createdAt', now - NEWEST_DAYS * DAY_MS),
    )
    .order('desc');
}

/** A time-bound lane's count, from its own range, and (for Suspended) when the soonest one lapses. */
export async function countTimeLane(
  ctx: QueryCtx,
  lane: 'suspended' | 'newest',
  now: number,
  rowsReady: boolean,
): Promise<{ count: Count; first: Doc<'peopleRows'> | null }> {
  const rows = await laneRange(ctx, lane, now).take(LANE_COUNT_CAP + 1);
  const counted = cappedCount(rows.length, LANE_COUNT_CAP);
  return { count: { ...counted, capped: counted.capped || !rowsReady }, first: rows[0] ?? null };
}

/** When the soonest running suspension lapses, from Suspended's first row; `null` for none or open-ended. */
export function soonestLapse(first: Doc<'peopleRows'> | null): number | null {
  return first === null || first.suspendedUntil >= OPEN_ENDED ? null : first.suspendedUntil;
}

// ── Queue lanes ────────────────────────────────────────────────────────────────────────────────

/** One person with open flags on them or their content. */
export interface FlaggedPerson {
  userId: Id<'profiles'>;
  onUser: number;
  onContent: number;
  /** When their oldest open flag was filed — the lane's order, oldest first. */
  oldestAt: number;
}

/**
 * The people the open flags are about, oldest open flag first. The count is exact when the flags read
 * was whole and every content flag carried its subject; otherwise it is a floor (`capped`).
 */
export function flaggedPeopleFrom(
  flags: readonly Doc<'contentFlags'>[],
  flagsCapped: boolean,
): { people: FlaggedPerson[]; count: Count } {
  const byPerson = new Map<string, FlaggedPerson>();
  let unknown = false;
  for (const flag of flags) {
    const subject = flagSubject(flag);
    if (subject === undefined) {
      unknown = true;
      continue;
    }
    if (subject === null) continue;
    const person = byPerson.get(subject) ?? {
      userId: subject,
      onUser: 0,
      onContent: 0,
      oldestAt: flag.createdAt,
    };
    if (flag.targetType === 'user') person.onUser++;
    else person.onContent++;
    person.oldestAt = Math.min(person.oldestAt, flag.createdAt);
    byPerson.set(subject, person);
  }
  const people = [...byPerson.values()].sort(
    (a, b) => a.oldestAt - b.oldestAt || (a.userId < b.userId ? -1 : 1),
  );
  return { people, count: { count: people.length, capped: flagsCapped || unknown } };
}

/** The open flag queue, read once for a page: the Overview's and the lanes' one read. */
export function readOpenFlagQueue(ctx: QueryCtx) {
  return readOpenFlags(ctx, LANE_COUNT_CAP);
}

/**
 * Every support ticket still waiting — `open` or `in_progress`, the rule `support_queue_depth` counts
 * by — each status read to the cap and one past it. PII (D37): callers check `inbox.support.read`.
 */
export async function readWaitingTickets(
  ctx: QueryCtx,
): Promise<{ tickets: Doc<'supportTickets'>[]; capped: boolean }> {
  const tickets: Doc<'supportTickets'>[] = [];
  let capped = false;
  for (const status of ['open', 'in_progress'] as const) {
    const page = await ctx.db
      .query('supportTickets')
      .withIndex('by_status', (q) => q.eq('status', status))
      .take(LANE_COUNT_CAP + 1);
    capped ||= page.length > LANE_COUNT_CAP;
    tickets.push(...page);
  }
  return { tickets, capped };
}

/** One person with an appeal open: an account ticket still waiting. */
export interface AppealingPerson {
  userId: Id<'profiles'>;
  appeals: number;
  oldestAt: number;
}

/**
 * Appeals are account tickets still waiting. `tickets` counts the tickets (the Overview's *open
 * appeals*); `people` lists who filed them, oldest first (the lane, which can only list a ticket with
 * a profile behind it). Both are floors whenever a status read stopped short.
 */
export function appealsFrom(
  waiting: readonly Doc<'supportTickets'>[],
  capped: boolean,
): { tickets: Count; people: AppealingPerson[]; peopleCount: Count } {
  const appeals = waiting.filter((t) => t.category === 'account');
  const byPerson = new Map<string, AppealingPerson>();
  for (const ticket of appeals) {
    if (ticket.userId === undefined) continue;
    const person = byPerson.get(ticket.userId) ?? {
      userId: ticket.userId,
      appeals: 0,
      oldestAt: ticket.createdAt,
    };
    person.appeals++;
    person.oldestAt = Math.min(person.oldestAt, ticket.createdAt);
    byPerson.set(ticket.userId, person);
  }
  const people = [...byPerson.values()].sort(
    (a, b) => a.oldestAt - b.oldestAt || (a.userId < b.userId ? -1 : 1),
  );
  return {
    tickets: {
      count: Math.min(appeals.length, LANE_COUNT_CAP),
      capped: capped || appeals.length > LANE_COUNT_CAP,
    },
    people,
    peopleCount: { count: people.length, capped },
  };
}

// ── The Overview's People card ─────────────────────────────────────────────────────────────────

/**
 * The Overview's People column, from the lanes' own reads. `flags` is the open queue the Overview
 * already read for its Inbox card; `tickets` the waiting support tickets, or `null` for a viewer who
 * may not see support (PII).
 */
export async function peopleCardFigures(
  ctx: QueryCtx,
  now: number,
  flags: { flags: Doc<'contentFlags'>[]; capped: boolean },
  tickets: { tickets: Doc<'supportTickets'>[]; capped: boolean } | null,
) {
  const stored = await readStoredCounts(ctx);
  const suspended = await countTimeLane(ctx, 'suspended', now, stored.rowsReady);
  const newest = await countTimeLane(ctx, 'newest', now, stored.rowsReady);
  return {
    moderators: stored.count('moderators'),
    admins: stored.count('admins'),
    newThisWeek: newest.count,
    suspended: suspended.count,
    nextSuspensionEnds: soonestLapse(suspended.first),
    banned: stored.count('banned'),
    flaggedPeople: flaggedPeopleFrom(flags.flags, flags.capped).count,
    appealsOpen: tickets === null ? null : appealsFrom(tickets.tickets, tickets.capped).tickets,
    leaving: stored.count('leaving'),
    // The 6-hourly rollup, as Metrics' total reads it, so the two figures stay one number.
    totalUsers: await accountsTotal(ctx),
  };
}
