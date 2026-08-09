/**
 * Per-body map summary cards (N6c Workstream E).
 *
 * The map is a field of anonymous polygons you must click one at a time. This is the compact card
 * that sits over the ones where something is happening, so a browsing skater can see *where people
 * are actually skating* without opening anything.
 *
 * ## The rule that makes it shippable into a sparse corpus (E3)
 *
 * **A body with no recent activity gets no card at all** — not an empty one. The old deferral
 * trigger for this feature was "wait until report density is high enough that a summary is non-empty
 * for most bodies"; that trigger is retired by this rule rather than by waiting, because a feature
 * that renders only where there is news is *correct* at any density. On a corpus with two reports it
 * draws two cards, which is exactly the signal a browsing skater wants.
 *
 * Activity is the trigger, **not** the name. A named lake with nothing happening gets no card: a name
 * alone is not news and the basemap already labels prominent water. An unnamed body with reports
 * *does* get one, because "someone skated here" is arguably more useful there than on a lake
 * everybody already knows.
 *
 * ## D86 — aggregate quality renders as a graded mark, never as a word
 *
 * "Great" is a sentence the app appears to be asserting about the ice, on the surface where a skater
 * is deciding whether to drive. Filled dots are unmistakably *a summary of what people said*: a
 * mark's referent is whatever the legend says it is, and the legend here is "how recent reporters
 * rated it". That is a fact about reports, which is the same class of content as the count beside it.
 *
 * **The dots read `reports.skateQuality`, not the Phase 6 thumbs.** The thumbs measure whether a
 * *report* was helpful — a well-written report of terrible ice earns them. Rendering that as an ice
 * quality mark would be a category error that gets more wrong the better the reporting is.
 */

import { revealBelowQuorum } from './profileReveal';
import { SKATE_QUALITIES, type SkateQuality } from './types';

/**
 * How recent a report or hazard must be to put a card on the map.
 *
 * **The same freshness window the feed and the report list already use**, rather than a fourth
 * number nobody can keep in step. If this needs to diverge later it should diverge loudly.
 */
export const SUMMARY_RECENT_DAYS = 14;

/** How many hazard types a card names before it stops being glanceable. */
export const SUMMARY_MAX_HAZARD_TYPES = 3;

/**
 * The minimum number of rated reports before any dots render.
 *
 * **The load-bearing rule of D86.** Below this: no dots at all, *not* a low score. One person's
 * opinion rendered as a consensus mark is the worst failure mode available here, and it fails
 * silently — the mark looks identical whether it summarises 1 report or 40. Same denominator
 * discipline as D78 on recurrence claims, and for the same reason.
 */
export const SUMMARY_QUALITY_QUORUM = 3;

/** How many dots the mark has. Four resolves "people liked it" from "people didn't" and no further. */
export const SUMMARY_QUALITY_DOTS = 4;

/**
 * Each quality's position on the 1–4 scale.
 *
 * Discrete, and deliberately not a continuous fill: a bar reads as a gauge and a gauge reads as an
 * instrument reading. Dots read as a tally, which is what this is.
 */
const QUALITY_VALUE: Record<SkateQuality, number> = {
  great: 4,
  good: 3,
  fair: 2,
  poor: 1,
};

/** The denormalized summary stored on a body and read by the map. */
export interface BodySummary {
  /** Visible reports inside the recency window, current season only. */
  recentReportCount: number;
  /** The most common active hazard types, most frequent first. */
  topHazardTypes: string[];
  /** Newest report's skate-end time, for ordering and for "how fresh is this". */
  latestReportAt?: number;
  /** Filled dots out of {@link SUMMARY_QUALITY_DOTS}. Absent below quorum — never zero-as-a-score. */
  qualityDots?: number;
  /** How many rated reports the mark summarises. The honest denominator the glance omits. */
  qualityCount?: number;
  updatedAt: number;
}

/**
 * Round a mean quality to filled dots.
 *
 * Exposed because the rounding is a policy rather than an implementation detail: `Math.round` here
 * means a mean of 3.5 shows four dots, and that is the generous direction on a scale where the top
 * value is "great". Worth revisiting if the mark stops discriminating — see the ceiling note below.
 */
export function qualityDotsFor(meanValue: number): number {
  return Math.min(SUMMARY_QUALITY_DOTS, Math.max(1, Math.round(meanValue)));
}

/**
 * Build the quality half of a summary from the qualities of recent visible reports.
 *
 * Returns `{}` below quorum, which is what makes "no dots" and "bad ice" different states rather
 * than the same rendering.
 *
 * ⚠ **Watch for a ceiling effect once there is real data.** If everyone rates everything "great" the
 * mark stops discriminating and becomes decoration. The fix if that happens is to make it relative to
 * the corpus — the same move `regionStats` makes for the caption's deciles — rather than to widen the
 * scale.
 */
export function summarizeQuality(
  qualities: readonly (SkateQuality | undefined)[],
): Pick<BodySummary, 'qualityDots' | 'qualityCount'> {
  const rated = qualities.filter((q): q is SkateQuality => q !== undefined && q in QUALITY_VALUE);
  if (rated.length < SUMMARY_QUALITY_QUORUM) return {};
  const mean = rated.reduce((sum, q) => sum + QUALITY_VALUE[q], 0) / rated.length;
  return { qualityDots: qualityDotsFor(mean), qualityCount: rated.length };
}

/**
 * The same summary, with the quorum bypassed for the reveal flag (N6c-2).
 *
 * **A separate function rather than a parameter on {@link summarizeQuality}**, and the separation is
 * the safety argument: the stored summary is written by the server, which has no business knowing
 * about a client display flag, and a boolean threaded through the storage path is one default away
 * from persisting a below-quorum mark. So the *stored* `qualityDots` is always quorum-respecting,
 * and this is a render-time-only widening that reads the raw qualities again.
 *
 * Returns `revealed: true` when the mark exists only because of the flag, so the caller can label it.
 */
export function summarizeQualityRevealed(
  qualities: readonly (SkateQuality | undefined)[],
  enabled: boolean,
): Pick<BodySummary, 'qualityDots' | 'qualityCount'> & { revealed?: boolean } {
  const honest = summarizeQuality(qualities);
  if (honest.qualityDots !== undefined || !revealBelowQuorum(enabled)) return honest;
  const rated = qualities.filter((q): q is SkateQuality => q !== undefined && q in QUALITY_VALUE);
  if (rated.length === 0) return honest;
  const mean = rated.reduce((sum, q) => sum + QUALITY_VALUE[q], 0) / rated.length;
  return { qualityDots: qualityDotsFor(mean), qualityCount: rated.length, revealed: true };
}

/** The most frequent hazard types, most frequent first, capped for glanceability. */
export function topHazardTypes(
  types: readonly string[],
  limit: number = SUMMARY_MAX_HAZARD_TYPES,
): string[] {
  const counts = new Map<string, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) // stable tie-break
    .slice(0, limit)
    .map(([type]) => type);
}

/**
 * Whether a summary is worth drawing a card for (E3).
 *
 * Activity — a recent report or an active hazard — and nothing else. A name is not a reason.
 */
export function summaryHasCard(
  summary: BodySummary | null | undefined,
  /**
   * The reveal flag (N6c-2). When on, **every body with a summary row draws a card**, including the
   * ones with nothing to report — so a walk-through can see where cards land, how they collide and
   * what they look like empty, none of which is observable on a corpus holding one report.
   *
   * Note it still requires a `summary` to exist: the flag reveals what the rules hide, not bodies
   * the sweep has never touched.
   */
  reveal = false,
): boolean {
  if (!summary) return false;
  if (reveal) return true;
  return summary.recentReportCount > 0 || summary.topHazardTypes.length > 0;
}

/**
 * The card's title.
 *
 * **Name plus town, reusing the Phase 5 feed card's rule**, because "Pond" is not hypothetical:
 * OSM's Northeast water layer is full of bodies literally named `Pond`, `Mill Pond` and `Beaver
 * Pond`, several within a few miles of each other. A card reading just **Pond** looks like a bug and
 * is ambiguous even to a local. *"Beaver Pond · Marshfield"* is useful.
 *
 * A body with no name at all still gets a card — its job there is to say *someone skated here* — so
 * this falls back to the place alone, and then to nothing, letting the caller render counts with no
 * title rather than inventing one.
 */
export function summaryTitle(body: { name?: string; place?: string }): string | undefined {
  if (body.name && body.place) return `${body.name} · ${body.place}`;
  return body.name ?? body.place;
}

/** The text alternative for the dots — the honest long form, naming the denominator. */
export function qualityMarkLabel(summary: BodySummary): string | undefined {
  if (summary.qualityDots === undefined || summary.qualityCount === undefined) return undefined;
  return `Rated ${summary.qualityDots} of ${SUMMARY_QUALITY_DOTS} by ${summary.qualityCount} recent report${
    summary.qualityCount === 1 ? '' : 's'
  }`;
}

/** Every quality value, for tests and for any consumer iterating the scale. */
export const QUALITY_VALUES = SKATE_QUALITIES;
