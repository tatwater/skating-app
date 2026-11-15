import type { api } from '@skating/convex/api';
import { type PeopleLane, type Restriction, TRUST_CLASS_LABELS } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';

import { type Count, countText } from '../../overview/overviewModel';
import { type AgeFrom, PEOPLE_LANE_INFO, SEARCH_INFO } from './peopleLanes';

/**
 * The People list's words, as pure functions of what the server returned: the lanes' counts, a
 * row's chips, sub-line, reason and age, and what a page that may be short or not ready says.
 *
 * **Three answers, never confused** (the server's contract, `people.ts`):
 * - **Not ready** (`pending`) — a backfill after a deploy hasn't finished, so a figure resting on it
 *   may be *wrong*, not merely short: "Still being prepared", never a number, never a "+".
 * - **A floor** (`capped`, `partial`, `reasons`) — a read stopped at its cap: "200+", and why, in
 *   words.
 * - **Not recorded** (`null`) — nothing on record: no figure is drawn, never a zero.
 */

export type LanesRead = FunctionReturnType<typeof api.people.lanes>;
export type LaneEntry = LanesRead['lanes'][number];
export type PeoplePage = FunctionReturnType<typeof api.people.listPage>;
export type PersonListRow = PeoplePage['rows'][number];
export type PartialReason = PeoplePage['reasons'][number];
export type Backfill = PeoplePage['pending'][number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The words for "a backfill hasn't finished": no number, no "+". */
export const STILL_PREPARING = 'Still being prepared';

// ── Counts ───────────────────────────────────────────────────────────────────────────────────

/** A lane's count as the sidebar draws it, or `null` when it may be wrong (not ready yet). */
export function laneCount(entry: LaneEntry | undefined): Count | null {
  if (entry === undefined || entry.pending.length > 0) return null;
  return entry.count;
}

/**
 * The note at the lanes' foot while some counts aren't ready: which lanes, or all of them. `null`
 * once every lane the viewer has is counted.
 */
export function lanesPendingNote(lanes: readonly LaneEntry[]): string | null {
  const waiting = lanes.filter((l) => l.pending.length > 0);
  if (waiting.length === 0) return null;
  if (waiting.length === lanes.length) return `Counts ${lower(STILL_PREPARING)}`;
  const names = waiting.map((l) => PEOPLE_LANE_INFO[l.lane].title);
  return `${listWords(names)} ${waiting.length === 1 ? 'count' : 'counts'} ${lower(STILL_PREPARING)}`;
}

/**
 * The list head's kicker: the lane's count and its order ("1 · soonest to lapse first"). While the
 * count isn't ready, or before it lands, only the order — the note over the rows says what isn't
 * ready; a search, which no read counts, says only its order.
 */
export function kickerText(
  lane: PeopleLane,
  entry: LaneEntry | undefined,
  searching: boolean,
): string {
  if (searching) return SEARCH_INFO.order;
  const order = PEOPLE_LANE_INFO[lane].order;
  if (entry === undefined || entry.pending.length > 0) return order;
  return `${countText(entry.count)} · ${order}`;
}

// ── Why a list may be short ──────────────────────────────────────────────────────────────────

/** Why a figure is a floor, in words — one sentence per reason the server gave. */
export function reasonWords(reason: PartialReason): string {
  switch (reason) {
    case 'rows_missing':
      return 'Someone the queue names isn’t listed yet, so this list is short';
    case 'flags_capped':
      return 'There are more open flags than one read covers, so flag figures are floors';
    case 'tickets_capped':
      return 'There are more waiting tickets than one read covers, so appeal figures are floors';
    case 'count_capped':
      return 'The count stopped at its limit; the list goes on past it';
  }
}

/** What a page may be missing because a backfill hasn't finished, in words; `null` if nothing. */
export function pendingWords(lane: PeopleLane | null, pending: readonly Backfill[]): string | null {
  if (membershipPending(lane, pending)) {
    return `${STILL_PREPARING}: this list may not have everyone yet`;
  }
  if (pending.includes('flagSubjects')) return `Open flags are ${lower(STILL_PREPARING)}`;
  return null;
}

/**
 * Whether the list on screen is short of the lane — not just its rows' figures: someone the queue
 * names has no row yet, or the queue the lane lists (Flagged's open flags, Appeals open's waiting
 * tickets) was read to its cap. A search (`lane` `null`) lists rows only, so is never short.
 */
export function listShort(lane: PeopleLane | null, reasons: readonly PartialReason[]): boolean {
  if (lane === null) return false;
  return (
    reasons.includes('rows_missing') ||
    (lane === 'flagged' && reasons.includes('flags_capped')) ||
    (lane === 'appeals' && reasons.includes('tickets_capped'))
  );
}

/**
 * What the list's end says once every row it can read is in, when that isn't "All N": still being
 * prepared while who is in it may be wrong, "N shown" while it's short of the lane; `null` for a
 * whole list (the end says "All N", or the lane's empty words).
 */
export function endWords(
  lane: PeopleLane | null,
  reasons: readonly PartialReason[],
  pending: readonly Backfill[],
  rows: number,
): string | null {
  if (membershipPending(lane, pending)) return STILL_PREPARING;
  if (listShort(lane, reasons))
    return rows === 0 ? 'None shown' : `${rows.toLocaleString('en-US')} shown`;
  return null;
}

/**
 * Whether who is in the list may be wrong: every list rests on the rows; Flagged, on each flag's
 * subject too. A search (`lane` `null`) rests on the rows.
 */
export function membershipPending(lane: PeopleLane | null, pending: readonly Backfill[]): boolean {
  return pending.includes('rows') || (lane === 'flagged' && pending.includes('flagSubjects'));
}

// ── A row ────────────────────────────────────────────────────────────────────────────────────

export type ChipTone = 'default' | 'dim' | 'warn' | 'bad';

export interface RowChip {
  /** Written capitalized; the badge sets it in caps. */
  label: string;
  tone: ChipTone;
}

export interface RowView {
  id: string;
  /** The real name — or the handle, for an account with no name on it. */
  name: string;
  handle: string;
  src: string | null;
  chips: RowChip[];
  /** The line under the name, or `null` when it would say nothing. */
  sub: string | null;
  /** The reason on file for a suspension or ban, quoted. */
  reason: string | null;
  /** The age the lane counts, or `null` when nothing on record gives one. */
  age: string | null;
}

/** What a page's rows can say about their open flags and appeals. */
export interface RowFacts {
  /** Open flag figures may be wrong: don't draw them. */
  flagsPending: boolean;
  /** Open flag figures are floors. */
  flagsFloor: boolean;
  /** Appeal figures are floors. */
  appealsFloor: boolean;
}

const RESTRICTION_WORDS: Record<Restriction, string> = {
  reports: 'reports',
  hazards: 'hazards',
  comments: 'comments',
  bounties: 'bounties',
  flagging: 'flagging',
};

const ROLE_WORDS = { admin: 'Admin', moderator: 'Moderator' } as const;

/** One row as the list draws it, for `lane` (`null` while a search runs). */
export function rowView(
  row: PersonListRow,
  lane: PeopleLane | null,
  facts: RowFacts,
  now: number,
): RowView {
  return {
    id: row.userId,
    name: row.displayName.trim() || row.username,
    handle: row.username,
    src: row.profileImageUrl,
    chips: rowChips(row),
    sub: subLine(row, lane, facts),
    reason: reasonLine(row),
    age: rowAge(row, lane === null ? 'joined' : PEOPLE_LANE_INFO[lane].age, now),
  };
}

/** The status chip (the one colored chip leads), then the trust class. */
export function rowChips(row: PersonListRow): RowChip[] {
  const chips: RowChip[] = [];
  if (row.status === 'banned') chips.push({ label: 'Banned', tone: 'bad' });
  else if (row.suspension !== null) chips.push({ label: 'Suspended', tone: 'warn' });
  if (row.status === 'deleted' || row.status === 'deleting') {
    chips.push({ label: 'Deleted', tone: 'dim' });
  } else if (row.leavingUntil !== null) {
    chips.push({ label: 'Leaving', tone: 'dim' });
  }
  if (row.trustClass !== null) {
    chips.push({ label: TRUST_CLASS_LABELS[row.trustClass], tone: 'default' });
  }
  return chips;
}

function subLine(row: PersonListRow, lane: PeopleLane | null, facts: RowFacts): string | null {
  const parts: string[] = [];
  if (row.role === 'admin' || row.role === 'moderator') parts.push(ROLE_WORDS[row.role]);
  if (row.suspension !== null) {
    parts.push(
      row.suspension.until === null ? 'Until lifted' : `Until ${weekdayDate(row.suspension.until)}`,
    );
  }
  if (row.restrictions.length > 0) {
    parts.push(`Restricted: ${listWords(row.restrictions.map((r) => RESTRICTION_WORDS[r]))}`);
  }
  if (row.deletedAt !== null) parts.push(`Deleted ${weekdayDate(row.deletedAt)}`);
  else if (row.leavingUntil !== null)
    parts.push(`Deletion completes ${weekdayDate(row.leavingUntil)}`);
  const flags = flagWords(row.openFlags, lane === 'flagged', facts);
  if (flags !== null) parts.push(flags);
  if (row.appeals !== null && row.appeals > 0) {
    parts.push(`${row.appeals}${facts.appealsFloor ? '+' : ''} ${plural(row.appeals, 'appeal')}`);
  }
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The row's open flags: "1 open flag"; on Flagged, where they are ("1 open flag on their content");
 * nothing while the figures may be wrong, and nothing for none (the page says when a floor's zero
 * may hide some).
 */
export function flagWords(
  flags: PersonListRow['openFlags'],
  split: boolean,
  facts: Pick<RowFacts, 'flagsPending' | 'flagsFloor'>,
): string | null {
  if (facts.flagsPending) return null;
  const total = flags.onUser + flags.onContent;
  if (total === 0) return null;
  const plus = facts.flagsFloor ? '+' : '';
  const head = `${total}${plus} open ${plural(total, 'flag')}`;
  if (!split) return head;
  if (flags.onUser === 0) return `${head} on their content`;
  if (flags.onContent === 0) return `${head} on them`;
  return `${head}: ${flags.onUser} on them, ${flags.onContent} on their content`;
}

function reasonLine(row: PersonListRow): string | null {
  const disciplined = row.status === 'banned' || row.suspension !== null;
  const reason = row.statusReason?.trim();
  return disciplined && reason ? `Reason: “${reason}”` : null;
}

/** The row's age as its lane counts it, or `null` when nothing on record gives one. */
export function rowAge(row: PersonListRow, from: AgeFrom, now: number): string | null {
  switch (from) {
    case 'status':
      return row.statusSince === null ? null : ageWords(now - row.statusSince);
    case 'restricted':
      return row.restrictedSince === null ? null : ageWords(now - row.restrictedSince);
    case 'joined':
      return ageWords(now - row.createdAt);
    case 'leaving':
      return row.leavingUntil === null ? null : timeLeft(row.leavingUntil - now);
    case 'seen':
      return null;
  }
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "Thu 15 Oct" — a day in the reader's zone, as the board writes a date in a sub-line. */
export function weekdayDate(at: number): string {
  const d = new Date(at);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * How long ago, units written out: "12 minutes", "5 hours", "4 days", "3 months", "2 years" —
 * rounded down, so a thing is "4 days" old until it is five. Never negative: a clock skew reads as
 * "0 minutes".
 */
export function ageWords(ms: number): string {
  const age = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (age < HOUR) return count(Math.floor(age / MINUTE), 'minute');
  if (age < DAY) return count(Math.floor(age / HOUR), 'hour');
  // Each unit takes over only once it reads two or more, so the words never go backwards: the last
  // day before "2 months" is 60, and the last month before "2 years" is 23.
  const days = age / DAY;
  const years = Math.floor(days / 365.25);
  if (years >= 2) return count(years, 'year');
  const months = Math.floor(days / 30.4375);
  if (months >= 2) return count(months, 'month');
  return count(Math.floor(days), 'day');
}

/** How long is left, units written out: "1 day left", "5 hours left", "Ends now" once it's past. */
export function timeLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'Ends now';
  if (ms < HOUR) return `${count(Math.max(1, Math.floor(ms / MINUTE)), 'minute')} left`;
  if (ms < DAY) return `${count(Math.floor(ms / HOUR), 'hour')} left`;
  return `${count(Math.floor(ms / DAY), 'day')} left`;
}

const count = (n: number, unit: string) => `${n.toLocaleString('en-US')} ${plural(n, unit)}`;
const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "a", "a and b", "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
