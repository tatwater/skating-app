import {
  BODY_FEATURE_TYPE_LABELS,
  type BodyFeatureType,
  DEFAULT_REMOVAL_THRESHOLD,
  HAZARD_TYPE_LABELS,
  type HazardFreshness,
  type HazardType,
  type Season,
  seasonOf,
} from '@skating/core';

/**
 * Body › Hazards' arithmetic. Pure, with `now` passed in.
 *
 * **D3, at its sharpest.** A hazard's freshness is how recently anyone looked, never whether the
 * ice is safe: a stale hazard keeps its row and its field (faded, never gone); an archived one was
 * voted healed by skaters, which is a report, not a clearance; an empty list says nothing was
 * marked — never that nothing is there.
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

/** "2026–27". */
export function seasonWord(season: Season): string {
  return `${season}–${String((season + 1) % 100).padStart(2, '0')}`;
}

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
  /** "3 “still there” · healing". */
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
        ...(healing ? ['“healing”'] : []),
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

/** The UTC day an instant falls on, as an index into `winterWindow(season)`; out of it, `null`. */
export function dayIndex(at: number, season: Season): number | null {
  const { start, days } = winterWindow(season);
  const i = Math.floor((at - start) / DAY);
  return i >= 0 && i < days ? i : null;
}

/** How many hazards were on the lake each day of a season, as a read would hand them. */
export type DailyOnLake = { season: Season; days: readonly { at: number; count: number }[] };

/**
 * One strip's values on the window: a count per day, `0` on a day the read covers with nothing on
 * the lake, and `null` on a day that hasn't happened yet (this winter after today) — never zero.
 */
export function stripValues(read: DailyOnLake, now: number): (number | null)[] {
  const { start, days } = winterWindow(read.season);
  const today = Math.floor((now - start) / DAY);
  const values: (number | null)[] = Array.from({ length: days }, (_, i) => (i <= today ? 0 : null));
  for (const d of read.days) {
    const i = dayIndex(d.at, read.season);
    if (i !== null && values[i] !== null) values[i] = (values[i] ?? 0) + d.count;
  }
  return values;
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
