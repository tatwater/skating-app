/**
 * **The whole-catalog proof** (B05 §2.1.3): the rule's invariants asserted on every run's real
 * answer, which CI's fixture can't carry. Phrased independently of `selectNaipPicks` — as sets and
 * maxima, not its sort — so a bug in the rule isn't also a bug in its check.
 *
 * - every cell with a candidate has a pick (a cell whose every candidate was struck is a **hole**);
 * - no candidate beats its pick under the rule (a **violation**): among the leaf-on frames the
 *   foliage list doesn't strike, else among the leaf-on frames, else among every frame;
 * - the stack holds every other frame of that pool's season, and no frame struck as turned sits
 *   above one that isn't;
 * - the selection's off-season list is exactly the cells the step picked, each with the right why.
 */

import {
  isCoarseNaipFrame,
  isLeafOnNaipFrame,
  isSharpNaipFrame,
  NAIP_SHARP_WINDOW_YEARS,
  type NaipCandidate,
  type NaipExclusion,
  type NaipFoliageStrike,
  type NaipSelection,
  naipFoliageStruck,
  quarterQuadCell,
  quarterQuadInState,
} from '@skating/core';

export interface SelectionCheck {
  /** Cells with a candidate and no pick: every candidate struck. */
  holes: string[];
  /** Cells listed only with frames coarser than 0.6 m (or none in their state): no candidate at all. */
  noCandidate: string[];
  /** Cells whose pick a candidate beats, with why. */
  violations: string[];
}

/** Does the rule choose `c` out of `pool` (non-empty)? */
function chosen(c: NaipCandidate, pool: readonly NaipCandidate[]): boolean {
  const latestDay = pool
    .map((f) => f.acquired)
    .sort()
    .at(-1) as string;
  const newestYear = Math.max(...pool.filter((f) => f.acquired === latestDay).map((f) => f.year));
  const sharp = pool.filter(
    (f) => isSharpNaipFrame(f.gsd) && f.year >= newestYear - NAIP_SHARP_WINDOW_YEARS,
  );
  const from = sharp.length > 0 ? sharp : pool;
  const best = from
    .map((f) => f.acquired)
    .sort()
    .at(-1);
  return from.includes(c) && c.acquired === best;
}

export function checkSelection(
  candidates: readonly NaipCandidate[],
  exclusions: readonly NaipExclusion[],
  selection: NaipSelection,
  foliageStrikes: readonly NaipFoliageStrike[] = [],
): SelectionCheck {
  const struck = new Set(exclusions.map((e) => e.itemId));
  const turned = naipFoliageStruck(foliageStrikes);
  const offSeason = new Map(selection.offSeason.map((c) => [c.key, c.why]));
  const listed = new Set<string>();
  const pools = new Map<string, Map<string, NaipCandidate>>();
  for (const c of candidates) {
    if (!quarterQuadInState(c.key, c.state)) continue;
    listed.add(c.key);
    if (isCoarseNaipFrame(c.gsd)) continue;
    const pool = pools.get(c.key) ?? new Map<string, NaipCandidate>();
    pool.set(c.itemId, c);
    pools.set(c.key, pool);
  }
  const picks = new Map(selection.picks.map((p) => [p.key, p]));

  const holes: string[] = [];
  const violations: string[] = [];
  for (const [key, byId] of pools) {
    const live = [...byId.values()].filter((c) => !struck.has(c.itemId));
    const pick = picks.get(key);
    if (pick === undefined) {
      if (live.length === 0) holes.push(key);
      else violations.push(`${key}: ${live.length} candidates and no pick`);
      continue;
    }
    const mid = quarterQuadCell(key).minLat + 1 / 32;
    const leafOn = live.filter((c) => isLeafOnNaipFrame(c.acquired, mid));
    const green = leafOn.filter((c) => !turned(c));
    const pool = green.length > 0 ? green : leafOn.length > 0 ? leafOn : live;
    if (!chosen(pick.pick, pool)) {
      violations.push(`${key}: ${pick.pick.itemId} is not the rule's choice of ${pool.length}`);
    }
    const season = leafOn.length > 0 ? leafOn : live;
    if (pick.stack.length !== season.length - 1) {
      violations.push(
        `${key}: a stack of ${pick.stack.length} for ${season.length - 1} alternates`,
      );
    }
    const firstTurned = pick.stack.findIndex((f) => turned(f));
    if (
      green.length > 0 &&
      firstTurned !== -1 &&
      pick.stack.slice(firstTurned).some((f) => !turned(f))
    ) {
      violations.push(`${key}: a frame struck as turned sits above a green one in the stack`);
    }
    const why = green.length > 0 ? undefined : leafOn.length > 0 ? 'allTurned' : 'noLeafOn';
    if (offSeason.get(key) !== why) {
      violations.push(
        `${key}: off-season ${offSeason.get(key) ?? 'no'}, the rule says ${why ?? 'no'}`,
      );
    }
  }
  for (const key of picks.keys()) {
    if (!pools.has(key)) violations.push(`${key}: a pick for a cell with no candidate`);
  }
  const noCandidate = [...listed].filter((k) => !pools.has(k));
  return { holes: holes.sort(), noCandidate: noCandidate.sort(), violations: violations.sort() };
}
