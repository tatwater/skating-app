import {
  BODY_FEATURE_TYPE_LABELS,
  type BodyFeatureType,
  DEFAULT_REMOVAL_THRESHOLD,
  HAZARD_TYPE_LABELS,
  type HazardFreshness,
  type HazardType,
  type Season,
  seasonOf,
  verdictLabel,
} from '@skating/core';

import { HAZARDS_WORDS, wordsContext } from './hazardsWords';

/**
 * Body › Hazards' arithmetic. Pure, with `now` passed in.
 *
 * **D3, at its sharpest.** A hazard's freshness is how recently anyone looked, never whether the
 * ice is safe: a stale hazard keeps its row and its field (faded, never removed); an archived one
 * was archived by skaters' votes, which is a report about a report, and its end isn't recorded; an
 * empty list says no hazard reports are on record — never that no hazard is there. Every string the
 * tab says lives in `hazardsWords.ts`, under that rule.
 */

// ── Ages ────────────────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * "4 h", "1 d" — how long since anyone last looked, as a list row writes it. Floors (a hazard
 * seen 47 hours ago was seen 1 day ago, not 2); under an hour is "< 1 h"; a clock that runs
 * backward (a seen-at in the future) reads as just now, never as negative.
 */
export function ageWords(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < HOUR) return '< 1 h';
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  return `${Math.floor(ms / DAY)} d`;
}

// ── Seasons ─────────────────────────────────────────────────────────────────────────────────────

export { seasonWord } from './hazardsWords';

/** The season bar: this season and the two before it as tabs, three more under Earlier. */
export function seasonChoices(current: Season): { bar: Season[]; earlier: Season[] } {
  return {
    bar: [current, current - 1, current - 2],
    earlier: [current - 3, current - 4, current - 5],
  };
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────

/** What a hazard row reads from `hazards.listForBody` (its `HazardView`). */
export type HazardInput = {
  _id: string;
  type: string;
  subAreaName?: string | undefined;
  freshness: HazardFreshness;
  provisional: boolean;
  healingState?: string | undefined;
  confirmCount: number;
  clusterConfirmCount?: number | undefined;
  goneCount: number;
  lastConfirmedAt: number;
  /** When it was first reported: its season, and the day its first-report mark is drawn on. */
  firstReportedAt: number;
  status: string;
};

export type HazardRow = {
  id: string;
  /** "Pressure ridge". */
  type: string;
  /** "fresh", "aging", "stale", or "unconfirmed" while no second skater has said it's there. */
  state: HazardFreshness | 'unconfirmed';
  /** Amber: the latest word was "healing, still unsafe". */
  healing: boolean;
  /** Where on the body, when the row says; `null` draws the type alone. */
  place: string | null;
  /** "3 “still there” · “Healing — still unsafe”". */
  sub: string;
  /** "1 d" — since anyone last looked. */
  age: string;
  /** "Gone" votes, and how many archive it. */
  gone: number;
  goneOf: number;
};

const typeLabel = (t: string) => HAZARD_TYPE_LABELS[t as HazardType] ?? t.replace(/_/g, ' ');

/**
 * The rows, freshest first (the server's order). **Every hazard keeps its row**, stale included:
 * a fade is confidence, not safety.
 */
export function hazardRows(hazards: readonly HazardInput[], now: number): HazardRow[] {
  return hazards.map((h) => {
    const still = h.clusterConfirmCount ?? h.confirmCount;
    // Only "healing, still unsafe" is amber; `none` and `disputed` are not a healing word.
    const healing = h.healingState === 'healing_unsafe';
    return {
      id: h._id,
      type: typeLabel(h.type),
      state: h.provisional ? 'unconfirmed' : h.freshness,
      healing,
      place: h.subAreaName ?? null,
      sub: [
        still === 0 ? 'No other sighting' : `${still} “still there”`,
        // The skaters' whole verdict, never a bare "healing": the word without "still unsafe"
        // reads as the hazard going away (D3), and a crossing's verdict is its own.
        ...(healing ? [`“${verdictLabel('healing_unsafe', h.type as HazardType)}”`] : []),
      ].join(' · '),
      age: ageWords(h.lastConfirmedAt, now),
      gone: Math.min(h.goneCount, DEFAULT_REMOVAL_THRESHOLD),
      goneOf: DEFAULT_REMOVAL_THRESHOLD,
    };
  });
}

/** An archived row: where it was, what, and when anyone last saw it. */
export type ArchivedRow = { id: string; type: string; place: string | null; lastSeen: string };

const DAY_MONTH = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });

/** "9 Feb" — a row's day-month. */
export function dayMonth(at: number): string {
  const parts = DAY_MONTH.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')}`;
}

export function archivedRows(hazards: readonly HazardInput[]): ArchivedRow[] {
  return hazards
    .filter((h) => h.status === 'archived')
    .map((h) => ({
      id: h._id,
      type: typeLabel(h.type),
      place: h.subAreaName ?? null,
      lastSeen: dayMonth(h.lastConfirmedAt),
    }));
}

// ── Known features ──────────────────────────────────────────────────────────────────────────────

/** What a feature row reads from `bodyFeatures.listForBody`. */
export type FeatureInput = {
  _id: string;
  type: string;
  geometryKind: 'point_radius' | 'line' | 'polygon';
  geometry: unknown;
  radiusMeters?: number | undefined;
  bufferMeters?: number | undefined;
  note?: string | undefined;
  subAreaName?: string | undefined;
  promotedFromHazardId?: string | undefined;
  createdAt: number;
};

export type FeatureRow = {
  id: string;
  type: string;
  /** Where, or its note, or `null`. */
  place: string | null;
  /** "Point, 60 m · From a pin, 21 Jan 2026". */
  sub: string;
};

const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function dayMonthYear(at: number): string {
  const parts = DAY_MONTH_YEAR.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}`;
}

function shapeWords(f: FeatureInput): string {
  if (f.geometryKind === 'point_radius') {
    return f.radiusMeters === undefined ? 'Point' : `Point, ${Math.round(f.radiusMeters)} m`;
  }
  const kind = f.geometryKind === 'line' ? 'Line' : 'Area';
  return f.bufferMeters === undefined ? kind : `${kind}, ${Math.round(f.bufferMeters)} m band`;
}

export function featureRows(features: readonly FeatureInput[]): FeatureRow[] {
  return features.map((f) => ({
    id: f._id,
    type: BODY_FEATURE_TYPE_LABELS[f.type as BodyFeatureType] ?? f.type.replace(/_/g, ' '),
    place: f.subAreaName ?? f.note ?? null,
    sub: `${shapeWords(f)} · ${f.promotedFromHazardId === undefined ? 'Drawn' : 'From a pin,'} ${dayMonthYear(f.createdAt)}`,
  }));
}

// ── The winters, a bar per day ──────────────────────────────────────────────────────────────────

/** The strips' window: 1 October to 1 April of the season — the winter, as the tape draws it. */
export function winterWindow(season: Season): { start: number; days: number } {
  const start = Date.UTC(season, 9, 1);
  return { start, days: Math.round((Date.UTC(season + 1, 3, 1) - start) / DAY) };
}

/** A winter that holds a 29 February (2023–24): the axis every winter is drawn on. */
const AXIS_SEASON = 2023;
/** Days on the winters' one axis: 1 October to 31 March, with a slot for 29 February. */
export const AXIS_DAYS = winterWindow(AXIS_SEASON).days;
/** The 29 February slot's index on the axis. */
const LEAP_SLOT = Math.round(
  (Date.UTC(AXIS_SEASON + 1, 1, 29) - winterWindow(AXIS_SEASON).start) / DAY,
);

/**
 * A winter's day index as its place on the winters' one axis. The axis keeps a slot for 29
 * February every winter, so two winters line up date for date — a winter with no 29 February
 * leaves that slot empty, and its days from 1 March on move one along, never a day off.
 */
export function axisIndex(i: number, season: Season): number {
  return winterWindow(season).days === AXIS_DAYS || i < LEAP_SLOT ? i : i + 1;
}

/** A winter's days placed on the axis: the 29 February slot of a winter without one is empty. */
export function onAxis<T>(days: readonly (T | null)[], season: Season): (T | null)[] {
  const out: (T | null)[] = Array.from({ length: AXIS_DAYS }, () => null);
  days.forEach((d, i) => {
    out[axisIndex(i, season)] = d;
  });
  return out;
}

/**
 * The clock a winter's day-by-day read (`bodyConsole.dailyHazards`) is handed, from the hour the
 * tab's clock holds. The server counts a hazard through the clock it is given, the clock itself
 * excluded, so the hour's start would leave out every hazard reported since — and in a day's first
 * hour every hazard still on the lake would miss today, which would then read *None marked* (D3).
 * So it is the hour's end, whose day is still today's; and never past the winter's end, so a
 * winter that is over keeps one argument and is not asked again every hour.
 */
export function dailyClock(season: Season, hour: number): number {
  const { start, days } = winterWindow(season);
  return Math.min(hour + HOUR, start + days * DAY);
}

/** The UTC day an instant falls on, as an index into `winterWindow(season)`; out of it, `null`. */
export function dayIndex(at: number, season: Season): number | null {
  const { start, days } = winterWindow(season);
  const i = Math.floor((at - start) / DAY);
  return i >= 0 && i < days ? i : null;
}

/**
 * How many hazards were on the lake each day of a winter, as `bodyConsole.dailyHazards` hands it.
 *
 * - `count` — hazards **known** to be on the lake that day (from a hazard's first report; one still
 *   active, through today);
 * - `unknown` — archived hazards that **may** have been: nothing stored says when an archived
 *   hazard left the lake, so every day after its first report is unknown — never clear, never
 *   ended;
 * - `unknownEnds` — how many archived hazards that is; `capped` — the read stopped at its most
 *   hazards, so every day is a floor; `watchOpensOn` — the season record's opening day, `null`
 *   while the watch waits.
 *
 * Days after today are absent; a day before today with no entry had nothing marked.
 */
export type DailyHazards = {
  season: Season;
  days: readonly { at: number; count: number; unknown: number }[];
  unknownEnds: number;
  capped: boolean;
  watchOpensOn: number | null;
};

/**
 * One day on a strip: hazards known on the lake (`count`, the server's), how many more may have been
 * (`unknown`, the server's), and — from the archived list — how many hazards with no recorded end
 * were first reported that day (`reported`, each a mark).
 */
export type DayOnLake = { count: number; unknown: number; reported: number };

/**
 * Each archived hazard's first report, as a count per day of the winter's window — the strip's
 * marks. **One mark per hazard with no recorded end, on the day it was first reported** (the
 * founder's ruling, 2026-11-14): every archived hazard today, since nothing stored says when one
 * left the lake. A hazard first reported outside the window (July to September) is on no strip.
 */
export function firstReports(hazards: readonly HazardInput[], season: Season): number[] {
  const out = Array.from({ length: winterWindow(season).days }, () => 0);
  for (const h of hazards) {
    if (h.status !== 'archived') continue;
    const i = dayIndex(h.firstReportedAt, season);
    if (i !== null) out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

/**
 * A day as the strip draws it: the marks, and the bars for the rest of the known count. The
 * server counts a hazard with no recorded end on its first-report day, so its mark stands in for
 * that day's share of the bar — **never fewer known hazards drawn than the server's `count`**, and
 * more only when the list holds a first report the count doesn't.
 */
export function drawnDay(day: DayOnLake): { bars: number; marks: number } {
  return { bars: Math.max(0, day.count - day.reported), marks: day.reported };
}

/** The known hazards a day draws and says: the server's count, or the marks where they exceed it. */
export const knownOn = (day: DayOnLake): number => Math.max(day.count, day.reported);

/**
 * One strip's days on the window: `{ count: 0, unknown: 0, reported: 0 }` on a day the read covers
 * with nothing marked, and `null` on a day that hasn't happened yet (this winter after today) —
 * never zero. `reported` is each day's first reports ({@link firstReports}); absent, none is drawn.
 * **A day the read or the list holds is never dropped**, whatever this clock says: a server day or
 * a first report past the viewer's today still draws, so no rendering ever shows fewer hazards
 * than either counted.
 */
export function stripDays(
  read: Pick<DailyHazards, 'season' | 'days'>,
  now: number,
  reported: readonly number[] | null = null,
): (DayOnLake | null)[] {
  const { start, days } = winterWindow(read.season);
  const today = Math.floor((now - start) / DAY);
  const empty = (): DayOnLake => ({ count: 0, unknown: 0, reported: 0 });
  const out: (DayOnLake | null)[] = Array.from({ length: days }, (_, i) =>
    i <= today ? empty() : null,
  );
  for (const d of read.days) {
    const i = dayIndex(d.at, read.season);
    if (i === null) continue;
    const held = out[i] ?? empty();
    out[i] = {
      ...held,
      count: held.count + Math.max(0, d.count),
      unknown: held.unknown + Math.max(0, d.unknown),
    };
  }
  reported?.forEach((n, i) => {
    if (n <= 0 || i >= days) return;
    const held = out[i] ?? empty();
    out[i] = { ...held, reported: held.reported + n };
  });
  return out;
}

/** A day in words, as its strip's title and today's line write it (`HAZARDS_WORDS.day`). */
export function dayWords(day: DayOnLake | null, capped: boolean): string {
  if (day === null) return 'Not yet';
  return HAZARDS_WORDS.day(
    wordsContext({ count: knownOn(day), unknown: day.unknown, reported: day.reported, capped }),
  );
}

/** One winter's strip as the tab draws it. */
export type WinterLine = {
  season: Season;
  days: (DayOnLake | null)[];
  capped: boolean;
  unknownEnds: number;
  /**
   * The archived list covers this winter, so its first reports are drawn as marks. When it
   * doesn't (last winter beside this one: the tab reads the archived list for the winter on screen
   * only), the strip draws no marks — the server's count as bars, the unknown in words — and says
   * which day each archived hazard was first reported isn't read.
   */
  marked: boolean;
};

/** The winters the tab draws: the season on screen first, then any it is set beside. */
export type Winters = {
  /** The days on the winters' one axis ({@link AXIS_DAYS}, a slot for 29 February kept). */
  days: number;
  months: readonly { at: number; label: string }[];
  lines: readonly WinterLine[];
  /** Today's place on the axis (the first strip's), while today is inside its window. */
  today: number | null;
  /** The watch's opening day's place on the axis (the first strip's), when the record says. */
  opens: number | null;
  /** When the first strip's record begins (1 October), while that is still ahead. */
  begins: number | null;
};

/**
 * The strips from their reads, the season on screen first. `lists[k]` is the hazards list (with
 * archived) for `reads[k]`'s winter, or `null` where the tab doesn't read one: that strip is drawn
 * without marks.
 */
export function wintersFrom(
  reads: readonly DailyHazards[],
  now: number,
  lists: readonly (readonly HazardInput[] | null)[] = [],
): Winters | null {
  const first = reads[0];
  if (first === undefined) return null;
  const { start, days } = winterWindow(first.season);
  const today = Math.floor((now - start) / DAY);
  const opens = first.watchOpensOn === null ? null : dayIndex(first.watchOpensOn, first.season);
  // Every strip on one axis, date for date (a leap winter beside a common one never a day off).
  return {
    days: AXIS_DAYS,
    months: monthTicks(AXIS_SEASON),
    lines: reads.map((r, k) => {
      const list = lists[k] ?? null;
      return {
        season: r.season,
        days: onAxis(
          stripDays(r, now, list === null ? null : firstReports(list, r.season)),
          r.season,
        ),
        capped: r.capped,
        unknownEnds: r.unknownEnds,
        marked: list !== null,
      };
    }),
    today: today >= 0 && today < days ? axisIndex(today, first.season) : null,
    opens: opens === null ? null : axisIndex(opens, first.season),
    begins: now < start && seasonOf(now) === first.season ? start : null,
  };
}

/** What a reader hears for a strip (`HAZARDS_WORDS.lineSummary`). */
export function lineSummary(line: WinterLine): string {
  let markedDays = 0;
  let unsureDays = 0;
  let reported = 0;
  for (const d of line.days) {
    if (d === null || knownOn(d) + d.unknown === 0) continue;
    markedDays++;
    if (d.unknown > 0) unsureDays++;
    reported += d.reported;
  }
  return HAZARDS_WORDS.lineSummary(
    wordsContext({ season: line.season, markedDays, unsureDays, reported, capped: line.capped }),
  );
}

/** The month ticks on the window: each 1st, as "OCT". */
export function monthTicks(season: Season): { at: number; label: string }[] {
  const { start } = winterWindow(season);
  const out: { at: number; label: string }[] = [];
  for (let m = 0; m < 6; m++) {
    const at = Date.UTC(season, 9 + m, 1);
    out.push({
      at: Math.round((at - start) / DAY),
      label: new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
        .format(at)
        .toUpperCase(),
    });
  }
  return out;
}

/** Is `season` the one `now` is in — the only one the tab's tools act on? */
export const isCurrent = (season: Season, now: number) => season === seasonOf(now);
