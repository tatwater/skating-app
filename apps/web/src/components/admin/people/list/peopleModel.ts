import type { api } from '@skating/convex/api';
import { type PeopleLane, TRUST_CLASS_LABELS } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';

import { shortAge } from '@/lib/ages';

import { type Count, countText, dayMonth } from '../../overview/overviewModel';
import { type AgeFrom, PEOPLE_LANE_INFO } from './peopleLanes';
import {
  ALL_COUNTS_PREPARING,
  CHIP_WORDS,
  countsPreparing,
  ENDS_NOW,
  FLAGS_PREPARING,
  flagPhrase,
  left,
  MAY_NOT_HAVE_EVERYONE,
  REASON_WORDS,
  ROLE_WORDS,
  SEARCH_WORDS,
  STILL_PREPARING,
  SUB_WORDS,
  someShown,
} from './peopleWords';

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

export { STILL_PREPARING };

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
  if (waiting.length === lanes.length) return ALL_COUNTS_PREPARING;
  return countsPreparing(waiting.map((l) => PEOPLE_LANE_INFO[l.lane].title));
}

/**
 * The list head's kicker: the lane's count and its order ("1 · by end date"). While the
 * count isn't ready, or before it lands, only the order — the note over the rows says what isn't
 * ready; a search, which no read counts, says only its order.
 */
export function kickerText(
  lane: PeopleLane,
  entry: LaneEntry | undefined,
  searching: boolean,
): string {
  if (searching) return SEARCH_WORDS.order;
  const order = PEOPLE_LANE_INFO[lane].order;
  if (entry === undefined || entry.pending.length > 0) return order;
  return `${countText(entry.count)} · ${order}`;
}

// ── Why a list may be short ──────────────────────────────────────────────────────────────────

/** Why a figure is a floor, in words — one sentence per reason the server gave. */
export function reasonWords(reason: PartialReason): string {
  return REASON_WORDS[reason];
}

/** What a page may be missing because a backfill hasn't finished, in words; `null` if nothing. */
export function pendingWords(lane: PeopleLane | null, pending: readonly Backfill[]): string | null {
  if (membershipPending(lane, pending)) return MAY_NOT_HAVE_EVERYONE;
  if (pending.includes('flagSubjects')) return FLAGS_PREPARING;
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
  if (listShort(lane, reasons)) return someShown(rows);
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
    sub: subLine(row, lane, facts, now),
    reason: reasonLine(row),
    age: rowAge(row, lane === null ? 'joined' : PEOPLE_LANE_INFO[lane].age, now),
  };
}

/** The status chip (the one colored chip leads), then the trust class. */
export function rowChips(row: PersonListRow): RowChip[] {
  const chips: RowChip[] = [];
  if (row.status === 'banned') chips.push({ label: CHIP_WORDS.banned, tone: 'bad' });
  else if (row.suspension !== null) chips.push({ label: CHIP_WORDS.suspended, tone: 'warn' });
  if (row.status === 'deleted' || row.status === 'deleting') {
    chips.push({ label: CHIP_WORDS.deleted, tone: 'dim' });
  } else if (row.leavingUntil !== null) {
    chips.push({ label: CHIP_WORDS.leaving, tone: 'dim' });
  }
  if (row.trustClass !== null) {
    chips.push({ label: TRUST_CLASS_LABELS[row.trustClass], tone: 'default' });
  }
  return chips;
}

function subLine(
  row: PersonListRow,
  lane: PeopleLane | null,
  facts: RowFacts,
  now: number,
): string | null {
  const parts: string[] = [];
  if (row.role === 'admin' || row.role === 'moderator') parts.push(ROLE_WORDS[row.role]);
  if (row.suspension !== null) {
    const { until } = row.suspension;
    parts.push(
      until === null
        ? SUB_WORDS.untilLifted
        : // The read is held at the list's clock; the row reads the live minute, so an end that has
          // passed while the list stayed open is never drawn as still ahead.
          until <= now
          ? SUB_WORDS.ranItsCourse(weekdayDate(until))
          : SUB_WORDS.until(weekdayDate(until)),
    );
  }
  if (row.restrictions.length > 0) parts.push(SUB_WORDS.restricted(row.restrictions));
  if (row.deletedAt !== null) parts.push(SUB_WORDS.deleted(weekdayDate(row.deletedAt)));
  else if (row.leavingUntil !== null) {
    parts.push(SUB_WORDS.deletionCompletes(weekdayDate(row.leavingUntil)));
  }
  const flags = flagWords(row.openFlags, lane === 'flagged', facts);
  if (flags !== null) parts.push(flags);
  if (row.appeals !== null && row.appeals > 0) {
    parts.push(SUB_WORDS.appeals(row.appeals, facts.appealsFloor));
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
  if (flags.onUser + flags.onContent === 0) return null;
  return flagPhrase(flags.onUser, flags.onContent, split, facts.flagsFloor);
}

function reasonLine(row: PersonListRow): string | null {
  const disciplined = row.status === 'banned' || row.suspension !== null;
  const reason = row.statusReason?.trim();
  return disciplined && reason ? SUB_WORDS.reason(reason) : null;
}

/**
 * The row's age as its lane counts it, in the row's short form ("4 d", "12 min", "12 d left" — the
 * console's list-row age, `shortAge`), or `null` when nothing on record gives one. Heads and notes
 * write their units out; a row never does.
 */
export function rowAge(row: PersonListRow, from: AgeFrom, now: number): string | null {
  switch (from) {
    case 'status':
      return row.statusSince === null ? null : shortAge(now - row.statusSince);
    case 'restricted':
      return row.restrictedSince === null ? null : shortAge(now - row.restrictedSince);
    case 'joined':
      return shortAge(now - row.createdAt);
    case 'leaving':
      if (row.leavingUntil === null) return null;
      return row.leavingUntil <= now ? ENDS_NOW : left(shortAge(row.leavingUntil - now));
    case 'seen':
      return null;
  }
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * "Thu 15 Oct" — a day in the reader's zone, as the board writes a date in a sub-line: the weekday
 * before the console's own day-and-month (`dayMonth`).
 */
export function weekdayDate(at: number): string {
  return `${WEEKDAYS[new Date(at).getDay()]} ${dayMonth(at)}`;
}

export { listWords } from './peopleWords';
