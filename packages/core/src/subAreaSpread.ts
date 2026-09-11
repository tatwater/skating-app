/**
 * How a giant describes itself: **the spread across its bays, with the ends named** (N6h / open
 * question 5, second half).
 *
 * ## The trap this refuses
 *
 * The obvious aggregate — highest high, lowest low, most snow, most wind, taken across all bays —
 * builds a *day that happened nowhere*. On Champlain the lowest low may be Missisquoi and the most
 * snow Broad Lake, 60 km apart; printed as one row they describe a lake that was simultaneously the
 * coldest and the snowiest place on itself. Every number true, the row false — the same failure PR
 * 1's review caught three times (the `since`-vs-total snow line, the UTC-vs-local anchor, the
 * borrowed-days count). It is not even consistently conservative: *lowest low* reads as reassuring
 * (colder → better ice) while *most snow* reads as discouraging, so the composite is incoherent
 * rather than pessimistic.
 *
 * **So this reports a range whose extremes are places.** *"Lows 0°F to 12°F — coldest at
 * Missisquoi Bay, mildest at Burlington Bay."* Every clause is true of somewhere real, the variation
 * is shown *as* variation, and the named ends are the tap targets: the affordance needs no
 * explaining because the data does the pointing.
 *
 * ## What it is not
 *
 * Not *"___ Bay is your best bet"* — a recommendation to drive somewhere, from air temperature alone,
 * by a system that knows nothing about depth, current, springs or whether anyone has been on the
 * ice. The most counsel-shaped sentence available short of a thickness (D3 / D150). The sorted bay
 * lists (*"bays by coldest nights"*) are the honest version and wait for Workstream E, where the
 * per-cell digest supplies their inputs.
 *
 * ## Same days, or no comparison
 *
 * A bay compared over fewer days is not "less snow", it is less knowledge — and an absent day reads
 * as *no snow fell* to any total, which is precisely the failure D161 step 4 exists to prevent. So
 * every bay is ranked over the **intersection** of the days they all have, and if that is fewer
 * than {@link SPREAD_MIN_DAYS} there is no spread at all. Nothing here fills a hole.
 *
 * ## Reads Tier B
 *
 * The rows are the corpus-wide `filter` tier's, cron-populated through the season, so the spread
 * costs nothing at read time and no fetch on drawer-open. 0.1° is coarse for a *reading* and ample
 * for *ranking* ten bays against each other — D152's two tiers applied to one lake. Bays that share a
 * Tier-B cell share rows and tie; the tie is reported as one place, the first by name.
 */

import { cmToInches, cToF } from './units';

/** Fewer shared days than this and the spread is withheld rather than computed over a thin sample. */
export const SPREAD_MIN_DAYS = 3;

/**
 * Lows closer together than this across every bay collapse to "similar". 3 °C (~5 °F) is about the
 * lapse-rate and lake-effect noise between two points 20 km apart on the same night; below it a
 * ranking would be ordering measurement scatter.
 */
export const SPREAD_LOW_SIMILAR_C = 3;

/** Snow totals closer together than this collapse to "similar". 2 cm is under an inch — a dusting. */
export const SPREAD_SNOW_SIMILAR_CM = 2;

export interface SpreadBayDay {
  dayMs: number;
  /** The night's minimum, when the archive saw the whole night; else the day's minimum. */
  nightMinTempC?: number | null;
  minTempC?: number | null;
  snowfallCm?: number | null;
}

export interface SpreadBayInput {
  subAreaId: string;
  name: string;
  /** Complete Tier-B days only — the caller drops `missing` markers and the in-progress today. */
  days: readonly SpreadBayDay[];
}

/** A named end of a range, and the tap target it is. */
export interface SpreadExtreme {
  subAreaId: string;
  name: string;
}

/**
 * A line is a sequence of prose and places. Clients render the places as the tap targets and the
 * prose as text, so the copy lives here — tested once — and neither client restates it to make a
 * name pressable. `text` is the same line flattened, for tests and for a surface with no taps.
 */
export type SpreadPart = string | SpreadExtreme;

export type SpreadLine =
  | {
      kind: 'lows';
      /** True when every bay's low fell inside {@link SPREAD_LOW_SIMILAR_C}. */
      similar: boolean;
      minF: number;
      maxF: number;
      coldest: SpreadExtreme;
      mildest: SpreadExtreme;
      parts: SpreadPart[];
      text: string;
    }
  | {
      kind: 'snow';
      similar: boolean;
      minIn: number;
      maxIn: number;
      least: SpreadExtreme;
      most: SpreadExtreme;
      parts: SpreadPart[];
      text: string;
    };

export function spreadLineText(parts: readonly SpreadPart[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : p.name)).join('');
}

export interface SubAreaSpread {
  /** Bays that were compared — those with every shared day. */
  bays: number;
  /** The shared window, in days. */
  days: number;
  /** True when every line collapsed: the honest one-liner replaces them. */
  similar: boolean;
  lines: SpreadLine[];
  /** The one-liner for the collapsed case; also usable as a heading when not collapsed. */
  summary: string;
}

const roundF = (c: number) => Math.round(cToF(c));
const roundIn = (cm: number) => Math.round(cmToInches(cm) * 10) / 10;

/** The bay's low over the window: the coldest night it saw, falling back to the coldest day. */
function bayLowC(days: readonly SpreadBayDay[]): number | null {
  let low: number | null = null;
  for (const d of days) {
    const v = typeof d.nightMinTempC === 'number' ? d.nightMinTempC : d.minTempC;
    if (typeof v !== 'number') continue;
    if (low === null || v < low) low = v;
  }
  return low;
}

function baySnowCm(days: readonly SpreadBayDay[]): number {
  let total = 0;
  for (const d of days) if (typeof d.snowfallCm === 'number') total += d.snowfallCm;
  return total;
}

/** Deterministic pick of an extreme: the best value, ties broken by name so two renders agree. */
function pickExtreme<T extends { name: string; value: number }>(
  items: readonly T[],
  better: (a: number, b: number) => boolean,
): T {
  let best = items[0] as T;
  for (const it of items) {
    if (better(it.value, best.value)) best = it;
    else if (it.value === best.value && it.name.localeCompare(best.name) < 0) best = it;
  }
  return best;
}

const formatIn = (v: number) => (v === 0 ? 'none' : `${v} in`);

/**
 * Build the spread, or `null` when there is nothing honest to say: fewer than two bays with data,
 * or fewer than {@link SPREAD_MIN_DAYS} days they all share.
 */
export function buildSubAreaSpread(inputs: readonly SpreadBayInput[]): SubAreaSpread | null {
  const withData = inputs.filter((b) => b.days.length > 0);
  if (withData.length < 2) return null;

  // The days every bay has. Ranking over anything wider would compare a bay's week against another
  // bay's four days and call the difference weather.
  let sharedDays = new Set<number>((withData[0] as SpreadBayInput).days.map((d) => d.dayMs));
  for (const bay of withData.slice(1)) {
    const mine = new Set(bay.days.map((d) => d.dayMs));
    sharedDays = new Set([...sharedDays].filter((d) => mine.has(d)));
  }
  if (sharedDays.size < SPREAD_MIN_DAYS) return null;

  const bays = withData.map((b) => ({
    subAreaId: b.subAreaId,
    name: b.name,
    days: b.days.filter((d) => sharedDays.has(d.dayMs)),
  }));

  const lines: SpreadLine[] = [];
  const dayCount = sharedDays.size;
  const window = `the last ${dayCount} day${dayCount === 1 ? '' : 's'}`;

  const lows = bays
    .map((b) => ({ subAreaId: b.subAreaId, name: b.name, value: bayLowC(b.days) }))
    .filter((b): b is { subAreaId: string; name: string; value: number } => b.value !== null);
  if (lows.length >= 2) {
    const coldest = pickExtreme(lows, (a, b) => a < b);
    const mildest = pickExtreme(lows, (a, b) => a > b);
    const similar = mildest.value - coldest.value < SPREAD_LOW_SIMILAR_C;
    const minF = roundF(coldest.value);
    const maxF = roundF(mildest.value);
    const coldestAt = { subAreaId: coldest.subAreaId, name: coldest.name };
    const mildestAt = { subAreaId: mildest.subAreaId, name: mildest.name };
    const parts: SpreadPart[] = similar
      ? [`Lows within a few degrees across the bays (${minF}°F to ${maxF}°F)`]
      : [`Lows ${minF}°F to ${maxF}°F — coldest at `, coldestAt, ', mildest at ', mildestAt];
    lines.push({
      kind: 'lows',
      similar,
      minF,
      maxF,
      coldest: coldestAt,
      mildest: mildestAt,
      parts,
      text: spreadLineText(parts),
    });
  }

  const snows = bays.map((b) => ({
    subAreaId: b.subAreaId,
    name: b.name,
    value: baySnowCm(b.days),
  }));
  if (snows.length >= 2) {
    const least = pickExtreme(snows, (a, b) => a < b);
    const most = pickExtreme(snows, (a, b) => a > b);
    const similar = most.value - least.value < SPREAD_SNOW_SIMILAR_CM;
    const minIn = roundIn(least.value);
    const maxIn = roundIn(most.value);
    const leastAt = { subAreaId: least.subAreaId, name: least.name };
    const mostAt = { subAreaId: most.subAreaId, name: most.name };
    const parts: SpreadPart[] = similar
      ? maxIn === 0
        ? [`No snow at any bay in ${window}`]
        : [`Snow in ${window} about the same everywhere (${formatIn(minIn)} to ${formatIn(maxIn)})`]
      : [`Snow in ${window}: ${formatIn(minIn)} at `, leastAt, `, ${formatIn(maxIn)} at `, mostAt];
    lines.push({
      kind: 'snow',
      similar,
      minIn,
      maxIn,
      least: leastAt,
      most: mostAt,
      parts,
      text: spreadLineText(parts),
    });
  }

  if (lines.length === 0) return null;
  const similar = lines.every((l) => l.similar);
  const bayWord = `${bays.length} bays`;
  return {
    bays: bays.length,
    days: dayCount,
    similar,
    lines,
    summary: similar
      ? `Similar across the lake's ${bayWord} over ${window}`
      : `Across ${bayWord} over ${window}`,
  };
}
