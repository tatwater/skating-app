import {
  BODY_FEATURE_TYPE_LABELS,
  type BodyFeatureType,
  DEFAULT_REMOVAL_THRESHOLD,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPES,
  type HazardFreshness,
  type HazardType,
  type Season,
  seasonEndMs,
  seasonStartMs,
  verdictLabel,
} from '@skating/core';

import { dayMonth, statusDate } from '../../frame/bodyModel';
import { drawingOf, type HazardDrawing, type Shaped } from './hazardDrawing';
import { CROSSING_WORDS, HAZARDS_WORDS, SHAPE_WORDS, wordsContext } from './hazardsWords';

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

/**
 * What a hazard row reads from `hazards.listForBody` (its `HazardView`). Its stored shape, so the row
 * says what the map draws for it by the map's own rule (`drawingOf`): *shape unknown* beside a pin,
 * *not on the map* where there is no usable point. **What the read returns and the tab doesn't keep,
 * and why**:
 * - the cluster's member ids: the map's (`hazardsMap` reads the same subscription);
 * - `reporterName`, `promotedFeatureType` and `placeLine`: never on the list path (only the
 *   single-hazard read resolves them), so nothing is dropped;
 * - `expired`: always false on the list (an expired crossing is left out by the read);
 * - the moderation and merge fields: the read returns only visible, unmerged hazards.
 * `bodyFeatures.listForBody` and `bodyConsole.dailyHazards` are kept whole.
 */
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
} & Omit<Shaped, '_id'>;

// ── What each type is ───────────────────────────────────────────────────────────────────────

/**
 * What a report of each hazard type is on the console: a **danger** (drawn as a dot field in the
 * warning tone, its row in red) or a **crossing** — `ridge_crossing`, a report that someone got
 * across a ridge there (D51/D64), drawn as its own mark and worded plainly, never as a danger and
 * never as a recommendation. Decided per type, never by a default: a type added to core fails to
 * compile here until someone says which it is.
 */
export type HazardKind = 'danger' | 'crossing';

export function hazardKind(type: HazardType): HazardKind {
  switch (type) {
    case 'ridge_crossing':
      return 'crossing';
    case 'open_water':
    case 'thin_ice':
    case 'overflow_slush':
    case 'drain_hole':
    case 'wind_hole':
    case 'slush_hole':
    case 'thawed_rotten':
    case 'wet_crack':
    case 'drilled_hole':
    case 'shell_area':
    case 'air_pockets':
    case 'pressure_ridge':
    case 'ice_heave':
    case 'spring_current':
    case 'gas_hole':
    case 'reef_hole':
      return 'danger';
    default: {
      const unhandled: never = type;
      return unhandled;
    }
  }
}

/**
 * A row's type as the read sends it (a string). A type this build doesn't know — the server ahead
 * of the client — is a danger: the conservative reading for a report on the ice (D3).
 */
export function kindOf(type: string): HazardKind {
  return (HAZARD_TYPES as readonly string[]).includes(type)
    ? hazardKind(type as HazardType)
    : 'danger';
}

export type HazardRow = {
  id: string;
  /** A danger, or a reported crossing (`hazardKind`): its row's words and tone follow. */
  kind: HazardKind;
  /** "Pressure ridge"; "Reported crossing". */
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

/** A hazard type's name as the row and the map's pin say it. */
export const hazardTypeLabel = (t: string) =>
  kindOf(t) === 'crossing'
    ? CROSSING_WORDS.label
    : (HAZARD_TYPE_LABELS[t as HazardType] ?? t.replace(/_/g, ' '));

/** A known feature type's name as the row and the map's pin say it. */
export const featureTypeLabel = (t: string) =>
  BODY_FEATURE_TYPE_LABELS[t as BodyFeatureType] ?? t.replace(/_/g, ' ');

/**
 * What a row adds about its place on the map, by the map's own rule: *shape unknown* where the map
 * draws a pin in place of its shape, *not on the map* where there is no usable point, and nothing
 * where its shape is drawn. A crossing is a mark at a point whatever its shape, so a pin changes
 * nothing about how it is drawn and adds no word.
 */
export function shapeNote(d: HazardDrawing, kind: HazardKind): string | null {
  if (d.kind === 'nowhere') return SHAPE_WORDS.nowhere;
  if (d.kind === 'pin' && kind !== 'crossing') return SHAPE_WORDS.unknown;
  return null;
}

/**
 * The rows, freshest first (the server's order). **Every hazard keeps its row**, stale included:
 * a fade is confidence, not safety.
 */
export function hazardRows(hazards: readonly HazardInput[], now: number): HazardRow[] {
  return hazards.map((h) => {
    const still = h.clusterConfirmCount ?? h.confirmCount;
    // Only "healing, still unsafe" is amber; `none` and `disputed` are not a healing word.
    const healing = h.healingState === 'healing_unsafe';
    const kind = kindOf(h.type);
    const onMap = shapeNote(drawingOf(h), kind);
    return {
      id: h._id,
      kind,
      type: hazardTypeLabel(h.type),
      state: h.provisional ? 'unconfirmed' : h.freshness,
      healing,
      place: h.subAreaName ?? null,
      sub: [
        kind === 'crossing'
          ? CROSSING_WORDS.again(still)
          : still === 0
            ? 'No other sighting'
            : `${still} “still there”`,
        // The skaters' whole verdict, never a bare "healing": the word without "still unsafe"
        // reads as the hazard going away (D3), and a crossing's verdict is its own.
        ...(healing ? [`“${verdictLabel('healing_unsafe', h.type as HazardType)}”`] : []),
        ...(onMap === null ? [] : [onMap]),
      ].join(' · '),
      age: ageWords(h.lastConfirmedAt, now),
      gone: Math.min(h.goneCount, DEFAULT_REMOVAL_THRESHOLD),
      goneOf: DEFAULT_REMOVAL_THRESHOLD,
    };
  });
}

/** An archived row: where it was, what, and when anyone last saw it ("9 Feb", a row's day-month). */
export type ArchivedRow = { id: string; type: string; place: string | null; lastSeen: string };

export function archivedRows(hazards: readonly HazardInput[]): ArchivedRow[] {
  return hazards
    .filter((h) => h.status === 'archived')
    .map((h) => ({
      id: h._id,
      type: hazardTypeLabel(h.type),
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

/** A stored size the row can say: a finite number of meters (a NaN radius is no size to print). */
const sayable = (m: number | undefined): m is number => m !== undefined && Number.isFinite(m);

function shapeWords(f: FeatureInput): string {
  if (f.geometryKind === 'point_radius') {
    return sayable(f.radiusMeters) ? `Point, ${Math.round(f.radiusMeters)} m` : 'Point';
  }
  const kind = f.geometryKind === 'line' ? 'Line' : 'Area';
  return sayable(f.bufferMeters) ? `${kind}, ${Math.round(f.bufferMeters)} m band` : kind;
}

export function featureRows(features: readonly FeatureInput[]): FeatureRow[] {
  return features.map((f) => {
    // A known feature is drawn exactly as a hazard is (Review 13), so its row says the same.
    const onMap = shapeNote(drawingOf(f), 'danger');
    return {
      id: f._id,
      type: featureTypeLabel(f.type),
      place: f.subAreaName ?? f.note ?? null,
      sub: `${shapeWords(f)} · ${f.promotedFromHazardId === undefined ? 'Drawn' : 'From a pin,'} ${statusDate(f.createdAt)}${onMap === null ? '' : ` · ${onMap}`}`,
    };
  });
}

// ── The winters, a bar per day ──────────────────────────────────────────────────────────────────

/**
 * The strips' window: the whole season, 1 July to the next 1 July (UTC) — the window
 * `bodyConsole.dailyHazards` counts over, so no hazard it counts falls off the strip. Days before 1
 * October are drawn like any other: a hazard first reported in September is a mark in September.
 */
export function winterWindow(season: Season): { start: number; days: number } {
  const start = seasonStartMs(season);
  return { start, days: Math.round((seasonEndMs(season) - start) / DAY) };
}

/** A winter that holds a 29 February (2023–24): the axis every winter is drawn on. */
const AXIS_SEASON = 2023;
/** Days on the winters' one axis: 1 July to 30 June, with a slot for 29 February. */
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

/** The axis's 29 February slot, in a winter that has none: a day that never comes for it. */
export function noSuchDay(i: number, season: Season): boolean {
  return i === LEAP_SLOT && winterWindow(season).days !== AXIS_DAYS;
}

/** An axis day's date in words ("12 Jan"), the same for every winter set on the axis. */
export function axisDayLabel(i: number): string {
  return dayMonth(winterWindow(AXIS_SEASON).start + i * DAY, 'UTC');
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
 * The clock a winter's day-by-day read (`bodyConsole.dailyHazards`) is handed: the start of the
 * tab's UTC day — the server counts through the whole of it, so the answer turns only on the day,
 * and an hour's turn asks nothing new — and never past the season's end, so a season that is over
 * keeps one argument.
 */
export function dailyClock(season: Season, hour: number): number {
  const { start, days } = winterWindow(season);
  return Math.min(Math.floor(hour / DAY) * DAY, start + days * DAY);
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
  /**
   * Each day: hazards known on the lake, those that may have been (`unknown`), and reported
   * crossings live that day (`crossings`, counted on their own — a crossing is a passage marker,
   * never a hazard, and never makes a day read safer).
   */
  days: readonly { at: number; count: number; unknown: number; crossings?: number }[];
  unknownEnds: number;
  /**
   * Each report counted: the day it was first reported, whether its end is recorded, whether it is
   * still active by its record (`active`), its type, and whether it is a reported crossing
   * (`passage`) — the strip's marks (one on its first-report day for each archived hazard with no
   * recorded end; a crossing is never a hazard's mark). `active` absent — a read from before the
   * server said it — is a state unknown, and never reads as archived.
   */
  hazards: readonly {
    firstReportedDay: number;
    endRecorded: boolean;
    active?: boolean;
    type?: string;
    passage?: boolean;
  }[];
  capped: boolean;
  watchOpensOn: number | null;
};

/**
 * One day on a strip: hazards known on the lake (`count`, the server's), how many more may have been
 * (`unknown`, the server's), and how many hazards with no recorded end were first reported that
 * day (`reported`, each a mark — from the read's own `hazards`).
 */
export type DayOnLake = {
  count: number;
  unknown: number;
  reported: number;
  /** Reported crossings live that day (the server's count): said on their own, never a hazard. */
  crossings?: number;
};

/**
 * The read's first reports, as a count per day of the season's window — the strip's marks. **One
 * mark per hazard with no recorded end, on the day it was first reported** (the founder's ruling,
 * 2026-11-14); a hazard whose end is recorded, or that is still active (on the lake through
 * today), is bars for its days on the lake, never a mark.
 *
 * **Archived only on a recorded fact.** Since B01-3n the read says whether each hazard is still
 * active by its record (`active`): a mark is drawn only for one the read says is no longer active
 * (`active: false`) and whose end isn't recorded — the server's own word, on any day, today's
 * included. A hazard still active is never marked: it is bars for the days the server counts it.
 *
 * A read from before the server said it (`active` absent) keeps the old rule, which is also the
 * server's own word, a day later: its archived hazards with no recorded end are *unknown* every day
 * after their first, so a day's first reports with no recorded end are marked only as far as the
 * unknown part grows the next day. On the day itself (today, or the season's last) nothing yet
 * says, and they are bars: on the lake that day, which is true. A state the read doesn't give is
 * never drawn as archived or gone.
 */
export function firstReports(
  read: Pick<DailyHazards, 'season' | 'hazards' | 'days'>,
  now: number,
): number[] {
  const { start, days } = winterWindow(read.season);
  const out = Array.from({ length: days }, () => 0);
  // A reported crossing is the server's to count (`days[].crossings`), never a hazard's mark.
  const hazards = read.hazards.filter((h) => h.passage !== true);
  if (hazards.every((h) => h.active !== undefined)) {
    for (const h of hazards) {
      if (h.endRecorded || h.active !== false) continue;
      const i = dayIndex(h.firstReportedDay, read.season);
      if (i !== null) out[i] = (out[i] ?? 0) + 1;
    }
    return out;
  }
  const noEnd = Array.from({ length: days }, () => 0);
  for (const h of hazards) {
    if (h.endRecorded || h.active === true) continue;
    const i = dayIndex(h.firstReportedDay, read.season);
    if (i !== null) noEnd[i] = (noEnd[i] ?? 0) + 1;
  }
  const unknown = new Map<number, number>();
  for (const d of read.days) {
    const i = dayIndex(d.at, read.season);
    if (i !== null) unknown.set(i, (unknown.get(i) ?? 0) + Math.max(0, d.unknown));
  }
  const today = Math.floor((now - start) / DAY);
  noEnd.forEach((n, i) => {
    if (n === 0 || i + 1 >= days || i + 1 > today) return;
    const grows = (unknown.get(i + 1) ?? 0) - (unknown.get(i) ?? 0);
    out[i] = Math.max(0, Math.min(n, grows));
  });
  return out;
}

/**
 * A day as the strip draws it: the marks, and the bars for the rest of the known count. The
 * server counts a hazard with no recorded end on its first-report day, so its mark stands in for
 * that day's share of the bar — **never fewer known hazards drawn than the server's `count`**, and
 * more only when the marks exceed it (a read whose `hazards` disagree with its own `days`).
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
 * **A day the read holds is never dropped**, whatever this clock says: a server day or a first
 * report past the viewer's today still draws, so no rendering ever shows fewer hazards than the
 * read counted.
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
      ...(d.crossings !== undefined && d.crossings > 0
        ? { crossings: (held.crossings ?? 0) + d.crossings }
        : {}),
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
  const words = HAZARDS_WORDS.day(
    wordsContext({ count: knownOn(day), unknown: day.unknown, reported: day.reported, capped }),
  );
  return day.crossings !== undefined && day.crossings > 0
    ? `${words} · ${CROSSING_WORDS.live(day.crossings)}`
    : words;
}

/**
 * A strip's day on the axis in words, as its title, its table row and the keyboard say it: the
 * day's own words, except the 29 February slot of a winter without one, which is no day at all.
 */
export function lineDayWords(
  line: Pick<WinterLine, 'season' | 'days' | 'capped'>,
  i: number,
): string {
  if (noSuchDay(i, line.season)) return HAZARDS_WORDS.noSuchDay(wordsContext());
  return dayWords(line.days[i] ?? null, line.capped);
}

/** One winter's strip as the tab draws it. */
export type WinterLine = {
  season: Season;
  days: (DayOnLake | null)[];
  capped: boolean;
  unknownEnds: number;
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
};

/** The strips from their reads, the season on screen first; each marks its own first reports. */
export function wintersFrom(reads: readonly DailyHazards[], now: number): Winters | null {
  const first = reads[0];
  if (first === undefined) return null;
  const { start, days } = winterWindow(first.season);
  const today = Math.floor((now - start) / DAY);
  const opens = first.watchOpensOn === null ? null : dayIndex(first.watchOpensOn, first.season);
  // Every strip on one axis, date for date (a leap winter beside a common one never a day off).
  return {
    days: AXIS_DAYS,
    months: monthTicks(AXIS_SEASON),
    lines: reads.map((r) => ({
      season: r.season,
      days: onAxis(stripDays(r, now, firstReports(r, now)), r.season),
      capped: r.capped,
      unknownEnds: r.unknownEnds,
    })),
    today: today >= 0 && today < days ? axisIndex(today, first.season) : null,
    opens: opens === null ? null : axisIndex(opens, first.season),
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

/**
 * The month ticks on the window: each 1st, as "OCT". Twelve months on the strip's width: each is
 * ticked, and the quarters' firsts are named (JUL, OCT, JAN, APR) so the labels never crowd.
 */
export function monthTicks(season: Season): { at: number; label: string }[] {
  const { start } = winterWindow(season);
  const out: { at: number; label: string }[] = [];
  for (let m = 0; m < 12; m++) {
    const at = Date.UTC(season, 6 + m, 1);
    out.push({
      at: Math.round((at - start) / DAY),
      label:
        m % 3 === 0
          ? new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
              .format(at)
              .toUpperCase()
          : '',
    });
  }
  return out;
}
