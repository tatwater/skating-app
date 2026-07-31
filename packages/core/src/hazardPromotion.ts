/**
 * Ranking last season's hazards by how likely they are to come back (N5a, D53 + D63).
 *
 * **Why this exists is a safety argument, not a tidiness one.** Seasonal scoping hides last winter's
 * hazards, so the first skater in November sees a clean map where there was a ridge. What covers that
 * is *promotion*: a hazard that forms in the same place every winter becomes a persistent
 * `bodyFeature`, which no seasonal reset touches. That makes the pre-first-ice pass a **safety task**,
 * and this module is what stops it being a memory test — it puts the most likely repeaters at the top
 * of the operator's list instead of asking them to remember which bay had the spring hole.
 *
 * **What this is not.** It is not a prediction that a hazard *will* recur, and nothing built on it may
 * phrase it as one (D3). It ranks *candidates for a human decision*. Real recurrence detection needs
 * several seasons of hazard rows to mean anything — with one season it is noise dressed as insight —
 * and it is deferred with that trigger written down. This is the interim: type, corroboration and
 * decay tier, all of which are facts about the row rather than claims about the ice.
 */

import { HAZARD_DECAY } from './hazardDecay';
import type { HazardType } from './types';

/**
 * The `bodyFeatures` types a hazard can be promoted into — a **subset** of the backend's
 * `BODY_FEATURE_TYPES`, narrow on purpose.
 *
 * Typed rather than left as `string` because the value's whole job is to be handed to
 * `bodyFeatures.promote`, whose argument is a literal union. A `string` return forced the operator
 * surface to write `promotesTo as 'spring_current'` — a cast that is a lie about three of the four
 * values and that would go on compiling if this table and the backend enum ever drifted apart.
 */
export type PromotionTarget =
  | 'spring_current'
  | 'gas_hole'
  | 'reef_hole'
  | 'recurring_pressure_ridge';

/**
 * The `bodyFeatures` type a hazard type promotes into (D53), or `null` when it has no permanent
 * equivalent.
 *
 * `null` is the common and correct answer. Open water, thin ice and slush are *events* — they happen
 * where conditions put them, and a permanent marker claiming otherwise would be a standing warning
 * nobody can clear. Only the types whose cause is a fixed feature of the lake bed or its flow have
 * somewhere to be promoted to.
 */
export function promotionTargetFor(type: HazardType): PromotionTarget | null {
  switch (type) {
    // Moving water at a spring, and gas or reef holes: the cause is the lake, not the winter.
    case 'spring_current':
      return 'spring_current';
    case 'gas_hole':
      return 'gas_hole';
    case 'reef_hole':
      return 'reef_hole';
    // A ridge that formed here last winter and the winter before is a recurring ridge — its own
    // feature type, which is deliberately named for the *pattern* rather than for a present ridge.
    case 'pressure_ridge':
    case 'ice_heave':
      return 'recurring_pressure_ridge';
    default:
      return null;
  }
}

/** One hazard, reduced to what the ranking reads. */
export interface PromotionCandidate {
  type: HazardType;
  /** Independent "still there" confirmations (author excluded) — the corroboration signal. */
  confirmCount: number;
  /** Independent "it's gone / never was" votes — evidence *against* it being a fixture. */
  goneCount: number;
}

/**
 * A 0–1 score for "worth an operator's attention before first ice". Higher is more likely to recur.
 *
 * Three inputs, in the order they matter:
 *
 * 1. **Decay tier**, which is the strongest signal we have and the only one that is about *physics*.
 *    Tier D is effectively permanent — the research calls those out as promotion candidates in so many
 *    words — and tier C is structural. Tier A is volatile by definition and scores near zero: a wind
 *    hole recurring is a coincidence of a January gale, not a property of the lake.
 * 2. **Corroboration**, capped. Six confirmations is not six times more promotable than one; what the
 *    count tells us is that the pin was real, which stops being in doubt quickly.
 * 3. **Contradiction**, subtracted. People voting a hazard gone is evidence it wasn't a fixture.
 *
 * A type with nowhere to be promoted to scores **0**, whatever its counts: the list exists to be
 * acted on, and an item whose action doesn't exist is worse than absent.
 */
export function promotionPriority(candidate: PromotionCandidate): number {
  if (promotionTargetFor(candidate.type) === null) return 0;
  const tierWeight = TIER_WEIGHT[HAZARD_DECAY[candidate.type].tier];
  const corroboration = Math.min(candidate.confirmCount, CORROBORATION_CAP) / CORROBORATION_CAP;
  const contradiction = Math.min(candidate.goneCount, CORROBORATION_CAP) / CORROBORATION_CAP;
  const score = tierWeight * (1 - CORROBORATION_SHARE) + corroboration * CORROBORATION_SHARE;
  return clamp01(score - contradiction * CORROBORATION_SHARE);
}

/**
 * Confirmations past this add nothing: the question they answer is "was it real", not "how big".
 *
 * Exported so the cross-season ranking reads the same number (N5c / §C5). Two rankings that disagreed
 * about how much a third confirmation is worth would put the same hazard in two different places on two
 * halves of one operator surface.
 */
export const CORROBORATION_CAP = 3;

/** How much of the score corroboration can move. The rest is the decay tier — the physical signal. */
const CORROBORATION_SHARE = 0.3;

/**
 * Tier → how permanent the research says that behavior is (`hazardDecay`'s A/B/C/D groupings).
 *
 * Exported for the same reason as `CORROBORATION_CAP`: the recurrence score reuses it, so the two
 * rankings cannot end up disagreeing about what a tier *means*.
 */
export const TIER_WEIGHT: Record<'A' | 'B' | 'C' | 'D', number> = {
  A: 0,
  B: 0.25,
  C: 0.7,
  D: 1,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Rank candidates for the pre-first-ice pass, most promotable first, dropping anything that scores 0.
 *
 * Ties keep their input order, which is the caller's (newest first), so two equally-promotable ridges
 * are offered in the order they were last seen.
 */
export function rankPromotionCandidates<T extends PromotionCandidate>(
  candidates: readonly T[],
): (T & { priority: number })[] {
  return candidates
    .map((candidate) => ({ ...candidate, priority: promotionPriority(candidate) }))
    .filter((candidate) => candidate.priority > 0)
    .sort((a, b) => b.priority - a.priority);
}
