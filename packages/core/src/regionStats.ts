/**
 * Per-state distribution statistics (N6c Workstream A5) — the comparison basis the derived caption
 * needs to say things like *"among the deepest in Vermont."*
 *
 * ## Why deciles per state, and not a percentile per body
 *
 * A caption wants to place a lake against its neighbours. The obvious shape — store each body's
 * percentile — is the wrong one: a percentile is a property of the *corpus*, not of the body, so
 * every import would invalidate all 116,070 of them and keeping them true would mean rewriting the
 * corpus on every run. Nobody would, so they would quietly become claims about a snapshot from
 * whenever the pass last completed.
 *
 * Deciles invert the dependency. **One row per state, nine numbers per metric**, recomputed from
 * the corpus after a pass. Bodies store nothing extra, a caption is a comparison against a number
 * it looks up at render time, and re-deriving the whole basis costs one job rather than 116,070
 * writes.
 *
 * ## Per state rather than per corpus
 *
 * *"Among the deepest lakes we know about"* spans five states and is nearly meaningless — Vermont
 * and coastal Maine are different populations. A skater's comparison set is regional, and `states`
 * is already on every row. A border-spanning body carries several states and is counted in each,
 * which is correct: Champlain genuinely is among the deepest in both Vermont and New York.
 */

/** How many cut points a decile block holds: the 10th through 90th percentiles. */
export const DECILE_COUNT = 9;

/** One metric's distribution within one state. */
export interface DecileBlock {
  /** The 10th…90th percentiles, ascending. Always `DECILE_COUNT` long. */
  deciles: number[];
  /** How many bodies carried this metric. The denominator, and it is load-bearing — see `decileRankOf`. */
  count: number;
}

/**
 * The smallest sample a decile block may describe.
 *
 * Below this the deciles are noise wearing a distribution's clothes: with eight lakes, "in the top
 * decile for depth" means "one of the deepest eight", which is not the claim the caption makes.
 * Same denominator discipline as **D78**'s recurrence bar and **D86**'s quorum floor, applied for
 * the same reason — a comparison that silently summarises three data points looks identical to one
 * summarising three thousand.
 */
export const MIN_DECILE_SAMPLE = 30;

/**
 * The 10th…90th percentiles of a sample, by linear interpolation between order statistics.
 *
 * Returns `null` below `MIN_DECILE_SAMPLE`, so a thin state produces *no* basis rather than a
 * confident-looking one. Non-finite values are dropped rather than sorted into place, where a
 * `NaN` would silently corrupt every cut point above it.
 */
export function computeDeciles(values: readonly number[]): DecileBlock | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length < MIN_DECILE_SAMPLE) return null;

  const deciles: number[] = [];
  for (let k = 1; k <= DECILE_COUNT; k++) {
    // Linear interpolation between the two neighbouring order statistics — the standard
    // "type 7" quantile, and what every stats package will agree with if someone checks.
    const pos = ((clean.length - 1) * k) / (DECILE_COUNT + 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, clean.length - 1);
    const frac = pos - lo;
    deciles.push((clean[lo] as number) * (1 - frac) + (clean[hi] as number) * frac);
  }
  return { deciles, count: clean.length };
}

/**
 * Which decile a value falls in: `0` = below the 10th percentile … `9` = at or above the 90th.
 *
 * Returns `null` when there is no usable basis, and a caller **must** treat that as "say nothing"
 * rather than as "average". The whole point of the block is that a comparison we cannot support is
 * a clause we omit (Workstream C rule 3).
 */
export function decileRankOf(value: number, block: DecileBlock | undefined | null): number | null {
  if (!block || block.count < MIN_DECILE_SAMPLE || block.deciles.length !== DECILE_COUNT) {
    return null;
  }
  if (!Number.isFinite(value)) return null;
  let rank = 0;
  for (const cut of block.deciles) {
    if (value >= cut) rank++;
    else break;
  }
  return rank;
}

/**
 * Is this value in the top decile of its state — the bar for *"among the deepest in Vermont"*?
 *
 * **A deliberately high bar.** The caption's comparative clauses are the ones most likely to be
 * read as a recommendation, so they fire for roughly one lake in ten and stay quiet otherwise. A
 * threshold at, say, the 70th percentile would put a superlative on a third of the corpus and the
 * word would stop meaning anything.
 */
export function isTopDecile(value: number, block: DecileBlock | undefined | null): boolean {
  return decileRankOf(value, block) === DECILE_COUNT;
}

/** Is this value in the bottom decile of its state? The mirror of `isTopDecile`. */
export function isBottomDecile(value: number, block: DecileBlock | undefined | null): boolean {
  return decileRankOf(value, block) === 0;
}
