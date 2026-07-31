/**
 * Cross-season recurrence — the second window on D77's one clustering primitive (N5c / D78).
 *
 * Within a winter the question is *"is this the same ridge you already marked?"*. Across winters it is
 * *"is this the ridge that forms here every winter?"* — the same geometric judgement at a looser
 * tolerance, plus the arithmetic in this file: how many distinct winters, out of how many, when in the
 * season, and how much of that is worth an operator's attention before first ice.
 *
 * **Everything here is history with a denominator, never a forecast.** *"Ridges usually form here"* and
 * *"there is a ridge here"* are different sentences and only one of them is ours (D3). So every number
 * this module produces is a fact about what was reported — and the ranking it computes is a **queue
 * order for a human**, not a probability. It may sort a list; it may never be printed as a percentage
 * or a likelihood, which is the line `hazardPromotion` already holds one window over.
 *
 * **A season contributes at most one observation.** Three skaters pinning the same ridge in one January
 * is one winter of evidence. That rule is not optional and is not a tuning knob: without it, one
 * enthusiastic week becomes "a pattern", which is the exact D3 trap this phase is built to avoid.
 */

import { haversineMeters, type LatLng } from './geometry';
import type { RecurrenceFamily } from './hazardCluster';
import { HAZARD_DECAY } from './hazardDecay';
import { CORROBORATION_CAP, TIER_WEIGHT } from './hazardPromotion';
import type { Season } from './season';
import type { BodyFeatureType, HazardType } from './types';

/**
 * How many winters back a recurrence claim looks — the **denominator**.
 *
 * Four is a compromise with a reason on each side. Shorter and a feature that skips a mild winter
 * reads as having stopped; longer and a lake that genuinely changed (a dredged channel, a new culvert)
 * goes on being described by ice from before it changed.
 */
export const RECURRENCE_WINDOW_SEASONS = 4;

/**
 * **The public bar.** How many distinct winters a cluster must have been reported in before a skater
 * ever sees it.
 *
 * Start at 2 of the last 4 and raise to 3 if it reads noisy once public. It also gates the *timing
 * window* ("late December to February"), deliberately: one constant governs both claims, so raising it
 * makes them more conservative together and they can never be set to disagree.
 */
export const RECURRENCE_PUBLIC_MIN_SEASONS = 2;

/**
 * **The master switch, and it is off.**
 *
 * The engine ships now because the corpus gate could not fire before ~2029 and deferring would have
 * meant three winters of rows nobody ever looked at as a series (D78). What ships *dark* is the
 * skater-facing half: until this is on, every output of this module reaches an operator dashboard and
 * nothing else. Flip it when the queue has been read across at least two rollovers and the clusters at
 * the current bar look like real patterns — a judgement from `/admin/recurrence` and the tuning chart,
 * not a date.
 *
 * There is no feature-flag system in this repo and this phase does not invent one: a constant and a
 * redeploy is the mechanism, matching every other threshold in the app.
 */
export const RECURRENCE_ADVISORIES_PUBLIC = false;

/**
 * The raised bar for the `volatile` family (D78 / §C7) — **three winters minimum, regardless of
 * `RECURRENCE_PUBLIC_MIN_SEASONS`**.
 *
 * Volatile types are volatile. Two ridges in a row is a pattern; two thin patches in a row is a
 * plausible accident, and the whole argument for letting this family propose a permanent feature at
 * all is that *recurrence* is what distinguishes "a thin patch happened here" from "this spot thaws
 * first, every year". That distinction needs more than two winters to make.
 */
export const VOLATILE_MIN_SEASONS = 3;

/**
 * The `bodyFeatures` type a family's recurrence proposes, or `null` when it proposes nothing.
 *
 * The first four mirror `promotionTargetFor` exactly — same types, same reasoning, one window out.
 * `volatile` is the one that only exists here, and it is the strongest case in the phase for why
 * recurrence is worth building: a single winter's thin patch is weather, and N5a scored tier-A types
 * at zero promotability and was right to. A spot that goes out early *every* March is not weather. It
 * is a property of the lake bed — shallow water over a sandbar, a reef, a delta, the lee of an island —
 * and `shallow_early_thaw` is unreachable from any hazard without this.
 */
export function suggestedFeatureTypeFor(family: RecurrenceFamily): BodyFeatureType | null {
  switch (family) {
    case 'ridge':
      return 'recurring_pressure_ridge';
    case 'spring':
      return 'spring_current';
    case 'gas':
      return 'gas_hole';
    case 'reef':
      return 'reef_hole';
    case 'volatile':
      return 'shallow_early_thaw';
  }
}

/** How many distinct winters a cluster needs before a skater may see it, family included. */
export function publicMinSeasonsFor(family: RecurrenceFamily): number {
  return family === 'volatile'
    ? Math.max(VOLATILE_MIN_SEASONS, RECURRENCE_PUBLIC_MIN_SEASONS)
    : RECURRENCE_PUBLIC_MIN_SEASONS;
}

/**
 * Is this cluster thin enough that only an operator should see it?
 *
 * The founder call at scoping was that a thin pattern is **admin-only** — a "seen in 1 of 1 seasons"
 * line never reaches a skater; it reaches the dashboard, so patterns can be watched forming and the
 * public bar set from evidence rather than from a guess. Stored on the row rather than applied by the
 * client, because a client-side filter is "admin-only if you don't open the network tab".
 *
 * Suppressed and promoted clusters are never public either, for different reasons: a suppressed one is
 * a human saying this is not a pattern, and a promoted one is already rendering permanently on the map
 * as a body feature, where an advisory beside it would be a second, weaker voice saying the same thing.
 */
export function isPubliclyVisible(cluster: {
  family: RecurrenceFamily;
  seasonsObserved: readonly Season[];
  suppressedAt?: number;
  promotedToFeatureId?: string;
}): boolean {
  if (!RECURRENCE_ADVISORIES_PUBLIC) return false;
  if (cluster.suppressedAt !== undefined) return false;
  if (cluster.promotedToFeatureId !== undefined) return false;
  return cluster.seasonsObserved.length >= publicMinSeasonsFor(cluster.family);
}

/** What the ranking reads. Every field is a fact about what was reported, never about what will be. */
export interface RecurrenceScoreInput {
  /** Distinct winters this cluster was reported in — **the** recurrence signal. */
  seasonsObserved: number;
  /** The denominator it is measured against. */
  windowSeasons: number;
  /** The type family's decay tier, via the member types (see `tierForTypes`). */
  tier: 'A' | 'B' | 'C' | 'D';
  /** Winters between the newest sighting and now. `0` = last winter. */
  seasonsSinceLastObserved: number;
  /**
   * Confirmations **per observed season**, not across members — so one enthusiastic winter cannot
   * outweigh a quiet recurring one, which is precisely the failure mode a raw total invites.
   */
  confirmationsPerSeason: number;
  /** Winters in which the community voted it fully healed. Mild evidence against a fixture. */
  healedSeasons: number;
  /** Distinct "there was never anything here" verdicts across members. Heavy evidence against. */
  neverExistedCount: number;
}

/**
 * How much of the score each input may move, in the weight order §C5 sets out.
 *
 * **Seasons dominate by design.** It is the only input that is about *recurrence* rather than about a
 * row; everything else is a fact the single-season list already had. If these are ever retuned, that
 * ordering is the invariant — a ranking where corroboration outweighed seasons observed would be
 * `rankPromotionCandidates` with extra steps.
 */
const SEASONS_SHARE = 0.5;
const TIER_SHARE = 0.25;
const RECENCY_SHARE = 0.15;
const RECURRENCE_CORROBORATION_SHARE = 0.1;

/** "It healed that winter" is a fact about that winter — real evidence against a fixture, but mild. */
const HEALED_PENALTY = 0.05;
/** "There was never anything here" is a claim the *report* was bogus. The opposite of corroboration. */
const NEVER_EXISTED_PENALTY = 0.25;

/**
 * A 0–1 score for "worth an operator's attention before first ice", across seasons.
 *
 * **Pure and property-tested, because this is where a sign error is invisible and consequential.** A
 * ranking that quietly sorted backwards would put the least likely repeaters at the top of a safety
 * pass and nobody would notice until a winter had gone by.
 *
 * A family that proposes nothing still scores — unlike `promotionPriority`, which returns 0 for a type
 * with nowhere to be promoted. The two lists differ because they answer different questions: that one
 * is a queue of *actions* and drops what cannot be acted on, while this one is also the basis of a
 * skater-facing *statement about history*, which is worth making whether or not anything is promotable.
 */
export function recurrencePriority(input: RecurrenceScoreInput): number {
  const seasons = input.windowSeasons > 0 ? input.seasonsObserved / input.windowSeasons : 0;
  const tier = TIER_WEIGHT[input.tier];
  // Linear decay across the window: a cluster last seen `windowSeasons` ago scores nothing for
  // recency. A pattern that stopped is evidence too — lakes change, and the ranking should say so.
  const recency =
    input.windowSeasons > 0 ? clamp01(1 - input.seasonsSinceLastObserved / input.windowSeasons) : 0;
  const corroboration =
    Math.min(input.confirmationsPerSeason, CORROBORATION_CAP) / CORROBORATION_CAP;

  const score =
    clamp01(seasons) * SEASONS_SHARE +
    tier * TIER_SHARE +
    recency * RECENCY_SHARE +
    corroboration * RECURRENCE_CORROBORATION_SHARE;

  const contradiction =
    Math.min(input.healedSeasons, input.windowSeasons) * HEALED_PENALTY +
    Math.min(input.neverExistedCount, CORROBORATION_CAP) * NEVER_EXISTED_PENALTY;

  return clamp01(score - contradiction);
}

/**
 * The decay tier a cluster is ranked at: the **most permanent** tier among its member types.
 *
 * Most permanent rather than an average, because a cluster is one physical thing and its tier is a
 * claim about that thing's behaviour. A cluster holding both `pressure_ridge` (C) and `ice_heave` (C)
 * is straightforward; one holding `thin_ice` (A) and `thawed_rotten` (A) is tier A whichever way you
 * count. Where they differ, the more structural reading is the one an operator should be shown, since
 * the list exists to surface things that come back.
 */
export function tierForTypes(types: readonly HazardType[]): 'A' | 'B' | 'C' | 'D' {
  const order: Record<'A' | 'B' | 'C' | 'D', number> = { A: 0, B: 1, C: 2, D: 3 };
  let best: 'A' | 'B' | 'C' | 'D' = 'A';
  for (const type of types) {
    const tier = HAZARD_DECAY[type].tier;
    if (order[tier] > order[best]) best = tier;
  }
  return best;
}

/**
 * Rank clusters, most promotable first. Ties keep input order, which is the caller's.
 *
 * Nothing is dropped, unlike `rankPromotionCandidates`: a low score is a low place in the queue, not a
 * reason to hide a winter's history from the operator whose job is to notice patterns forming.
 */
export function rankRecurrence<T extends RecurrenceScoreInput>(
  clusters: readonly T[],
): (T & { priority: number })[] {
  return clusters
    .map((cluster) => ({ ...cluster, priority: recurrencePriority(cluster) }))
    .sort((a, b) => b.priority - a.priority);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * The member whose footprint centre is most central to the cluster — the **representative**.
 *
 * A medoid rather than a centroid, and the difference is the point: a medoid is a shape somebody
 * actually drew. An averaged line can bend a ridge through ice nobody ever marked, and a promoted
 * cluster inherits this geometry as a permanent feature, so "a real ridge's shape" is the requirement
 * rather than "the middle of the ridges".
 *
 * Ties break on the **earliest** member, so the choice is stable across recomputes — a representative
 * that flipped between two equidistant pins would rewrite a body feature's shape on a job nobody ran
 * on purpose.
 */
export function medoidOf<T extends { id: string; centre: LatLng; firstReportedAt: number }>(
  members: readonly T[],
): T | null {
  if (members.length === 0) return null;
  let best: { member: T; total: number } | null = null;
  for (const candidate of members) {
    let total = 0;
    for (const other of members) {
      if (other.id === candidate.id) continue;
      total += haversineMeters(candidate.centre, other.centre);
    }
    if (
      best === null ||
      total < best.total ||
      (total === best.total && candidate.firstReportedAt < best.member.firstReportedAt) ||
      (total === best.total &&
        candidate.firstReportedAt === best.member.firstReportedAt &&
        candidate.id < best.member.id)
    ) {
      best = { member: candidate, total };
    }
  }
  return best?.member ?? null;
}
