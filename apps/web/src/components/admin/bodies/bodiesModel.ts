import { sqMetersToAcres, waterBodyClassLabel } from '@skating/core';

import { type Count, clockTime, DAY, dayMonth } from '../overview/overviewModel';

/**
 * The Bodies library as data: what a row of the list is, what the preview reads, the columns and
 * their sort, and the pure rules that turn those into what a cell says.
 *
 * **`null` means "not recorded"** everywhere here — a read that doesn't exist yet, or a field the
 * read didn't carry — and is drawn as absent, never as a zero or a guess. A recorded zero is a
 * value (`0` asks reads "—", the boards' zero).
 */

// ── Standing ─────────────────────────────────────────────────────────────────────────────────

/** Where a body stands, as the library files it: one lane per key under *Standing*. */
export const BODY_STANDINGS = [
  'active',
  /** Dormant, the reason not read (a search hit says only that it isn't active). */
  'dormant',
  'inactive',
  'not_in_campaign',
  'moderator',
  'no_public_access',
  'removed',
  'rejected',
] as const;
export type BodyStandingKey = (typeof BODY_STANDINGS)[number];

/** A standing in the library's words — a row's sub-line when it isn't the lane's own. */
export const STANDING_LABEL: Record<BodyStandingKey, string> = {
  active: 'Active',
  dormant: 'Dormant',
  inactive: 'Dormant · inactive',
  not_in_campaign: 'Dormant · not in campaign',
  moderator: 'Dormant · moderator',
  no_public_access: 'No public access',
  removed: 'Removed',
  rejected: 'Rejected',
};

/** The word a group divider uses for the standings it gathers ("Dormant 4"). */
export function standingGroupWord(standing: BodyStandingKey): string {
  if (standing === 'active') return 'Active';
  if (standing === 'removed' || standing === 'rejected') return 'Removed';
  if (standing === 'no_public_access') return 'No public access';
  return 'Dormant';
}

// ── A row ────────────────────────────────────────────────────────────────────────────────────

/** How much of what every body should have it has (the completeness strip). */
export interface Completeness {
  /** Fields the record has. */
  have: number;
  /** Fields every body should have. */
  of: number;
  /** What's missing, in the preview's words ("bathymetry"). */
  missing: readonly string[];
}

/** One body as the list draws it. */
export interface BodyRow {
  id: string;
  name: string;
  /** An alias the search matched where the name didn't ("Morgan Pond"). */
  matchedAlias?: string;
  /** The stored class (`lakePond`, `reservoir`…). */
  bodyClass: string;
  /** Two-letter states it touches. */
  states: readonly string[];
  areaSqM: number | null;
  complete: Completeness | null;
  /** Open asks of this body (inbox items and corpus tasks). */
  asks: number | null;
  /** Some ask waits on a person (the amber count). */
  asksWaiting?: boolean;
  /** Reports this season. */
  reports: number | null;
  /** When its record last changed. */
  changedAt: number | null;
  standing: BodyStandingKey;
}

// ── Columns and their sort ───────────────────────────────────────────────────────────────────

export const BODY_COLUMNS = [
  'name',
  'class',
  'state',
  'acres',
  'complete',
  'asks',
  'reports',
  'changed',
] as const;
export type BodyColumnId = (typeof BODY_COLUMNS)[number];

export type SortDir = 'asc' | 'desc';

/** The list's order: a column and its direction, or `match` while a search ranks it. */
export type BodySort = { column: BodyColumnId; dir: SortDir } | { column: 'match' };

/** A heading's words, as the board writes them (the kicker sets them in caps). */
export const COLUMN_LABEL: Record<BodyColumnId, string> = {
  name: 'Body',
  class: 'Class',
  state: 'State',
  acres: 'Acres',
  complete: 'Complete',
  asks: 'Asks',
  reports: 'Reports',
  changed: 'Changed',
};

/** Which way a column sorts on its first press: words A→Z, numbers and dates biggest first. */
export const FIRST_DIR: Record<BodyColumnId, SortDir> = {
  name: 'asc',
  class: 'asc',
  state: 'asc',
  acres: 'desc',
  complete: 'desc',
  asks: 'desc',
  reports: 'desc',
  changed: 'desc',
};

/** A press on a heading: its first direction, or the other one if it's already the sort. */
export function nextSort(current: BodySort, column: BodyColumnId): BodySort {
  if (current.column === column) {
    return { column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { column, dir: FIRST_DIR[column] };
}

/** A row's value in a column, for a sort; `null` when it isn't recorded. */
function sortValue(row: BodyRow, column: BodyColumnId): string | number | null {
  switch (column) {
    case 'name':
      return row.name.toLocaleLowerCase();
    case 'class':
      return classWord(row.bodyClass);
    case 'state':
      return row.states.join(' ');
    case 'acres':
      return row.areaSqM;
    case 'complete':
      return row.complete === null ? null : row.complete.have / row.complete.of;
    case 'asks':
      return row.asks;
    case 'reports':
      return row.reports;
    case 'changed':
      return row.changedAt;
  }
}

/**
 * Orders rows by `sort` — over a list held **whole**, never a page of one (a page's order is the
 * server's). Unrecorded values sort last either way, so they never read as the smallest or the
 * largest; ties keep the name order, then the id, so the order is total and stable.
 */
export function sortRows(rows: readonly BodyRow[], sort: BodySort): BodyRow[] {
  if (sort.column === 'match') return [...rows];
  const { column, dir } = sort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, column);
    const vb = sortValue(b, column);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return (va < vb ? -1 : 1) * sign;
    }
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── What a cell says ─────────────────────────────────────────────────────────────────────────

/** The class as a cell writes it: core's word, lowercased ("lake or pond", "reservoir"). */
export function classWord(bodyClass: string): string {
  return waterBodyClassLabel(bodyClass).toLocaleLowerCase();
}

/** The states as a cell writes them: "VT · NY". */
export function statesText(states: readonly string[]): string {
  return states.join(' · ');
}

/** Whole acres, grouped: "1,143". Under one acre keeps a tenth ("0.4"). */
export function acresText(areaSqM: number): string {
  const acres = sqMetersToAcres(areaSqM);
  if (acres < 1) return (Math.round(acres * 10) / 10).toLocaleString('en-US');
  return Math.round(acres).toLocaleString('en-US');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Local midnight of the day `at` falls on. */
function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * When a row last changed, as the board's *Changed* column writes it: the clock today ("11:20"),
 * the weekday within the six days before ("Wed"), the day and month before that ("19 Sep").
 * Calendar days in the reader's zone; a change stamped ahead of the clock reads as today.
 */
export function changedWhen(at: number, now: number): string {
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (daysAgo <= 0) return clockTime(at);
  if (daysAgo <= 6) return WEEKDAYS[new Date(at).getDay()] as string;
  return dayMonth(at);
}

/** A count of asks as the board writes it: "—" for none, the number otherwise. */
export function asksText(asks: number): string {
  return asks === 0 ? '—' : asks.toLocaleString('en-US');
}

/** "1,412", or "200+" once the read stopped counting. */
export function countWords({ count, capped }: Count): string {
  return `${count.toLocaleString('en-US')}${capped ? '+' : ''}`;
}

/** What's missing, as the preview's line reads: "Missing bathymetry, posted rules and a lot". */
export function missingText(missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  if (missing.length === 1) return `Missing ${missing[0]}`;
  return `Missing ${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`;
}

// ── The page's kicker ────────────────────────────────────────────────────────────────────────

/**
 * The kicker beside the page word: "1,412 of 24,871 in the corpus", or — once a filter narrows
 * the lane — "187 of 1,412 active · 1,000 ac and up". Says only what it knows: a lane with no
 * count yet says nothing, a corpus with no total drops its half.
 */
export function laneKicker({
  shown,
  lane,
  corpus,
  laneWord,
  narrowedBy,
}: {
  /** How many the list holds now (after filters), when the read says. */
  shown: Count | null;
  /** How many the lane holds. */
  lane: Count | null;
  /** How many bodies the corpus holds. */
  corpus: Count | null;
  /** The lane in a word, for "of 1,412 active". */
  laneWord: string;
  /** The applied filters' chip words, in order. */
  narrowedBy: readonly string[];
}): string | null {
  if (narrowedBy.length > 0) {
    if (shown === null) return narrowedBy.join(' · ');
    const of = lane === null ? '' : ` of ${countWords(lane)} ${laneWord}`;
    return [`${countWords(shown)}${of}`, ...narrowedBy].join(' · ');
  }
  if (lane === null) return null;
  if (corpus === null) return countWords(lane);
  return `${countWords(lane)} of ${countWords(corpus)} in the corpus`;
}
