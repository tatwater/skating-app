/**
 * **Which NAIP frame each quarter-quad shows** in the summer aerial (B05 §2.1, D315).
 *
 * One rule, two callers: the select stage (`scripts/aerial`) builds the archive's manifest with it,
 * and the July reassessment (Convex) re-runs it on the live catalog and diffs the answer against the
 * published manifest. It lives here so the two can never disagree about what a good frame is.
 *
 * PLACEHOLDER (S's): the T0 seam. The types and constants are final; `selectNaipPicks` and
 * `diffNaipPicks` throw until S replaces their bodies.
 */

import type { NaipManifest } from './naipManifest';

/**
 * The rule's version, stamped into every manifest. Bump it whenever the rule could pick a different
 * frame for the same catalog, so a manifest says which rule built it and a partial rebuild never
 * mixes two rules' picks under one input hash.
 */
export const NAIP_RULE_VERSION = 1;

/**
 * The seven states the archive covers, each whole (the founder: the supported five plus CT and RI).
 * Uppercase two-letter codes, as `naip:state` labels them once uppercased. Wider than
 * `KNOWN_STATE_CODES`, which is the five the corpus covers.
 */
export const NAIP_STATES = ['NY', 'VT', 'NH', 'ME', 'MA', 'CT', 'RI'] as const;
export type NaipState = (typeof NAIP_STATES)[number];

/** Is `code` one of the seven (uppercase)? */
export function isNaipState(code: string): code is NaipState {
  return (NAIP_STATES as readonly string[]).includes(code);
}

/**
 * One catalog item, compacted to what the rule reads: a NAIP quarter-quad frame.
 *
 * The catalog lists ~69,000 of these for the region; holding them compact is what lets the July
 * check walk the whole catalog inside one action.
 */
export interface NaipCandidate {
  /** The STAC item id, e.g. `vt_m_4507264_sw_18_030_20250920`. */
  itemId: string;
  /** The quarter-quad key decoded from the item id, e.g. `4507264sw` (`naipGrid.ts`). */
  key: string;
  /** The state the catalog labels it with (`naip:state`, uppercased) — not always where it lies. */
  state: NaipState;
  /** The acquisition day, `YYYY-MM-DD`, from the item's `datetime` (never the program year). */
  acquired: string;
  /** Ground sample distance in meters (`gsd`): 0.3, 0.6, 1. */
  gsd: number;
  /** The program year (`naip:year`). */
  year: number;
  /** The item's footprint, STAC order: `[west, south, east, north]`, degrees. */
  bbox: readonly [number, number, number, number];
}

/** Why a reviewed frame is struck. */
export type NaipExclusionReason = 'cloud' | 'glare';

/**
 * A frame struck by review (§2.1.2). Never by threshold alone: a person looked at it. Struck before
 * the season step, so the cell falls back to its next leaf-on frame.
 */
export interface NaipExclusion {
  itemId: string;
  reason: NaipExclusionReason;
  /** `founder` for a frame that changed a pick; `builder` for one that was only a fallback. */
  reviewedBy: 'founder' | 'builder';
  /** The review's day, `YYYY-MM-DD`. */
  reviewedOn: string;
}

/**
 * Which step picked a cell's frame: `leafOn` (the rule's steps 2–4), or `offSeason` (step 5, a cell
 * with no leaf-on candidate at all; allowed only for `NAIP_OFF_SEASON_CELLS`).
 */
export type NaipPickStep = 'leafOn' | 'offSeason';

/** One quarter-quad's answer. */
export interface NaipCellPick {
  /** The quarter-quad key. */
  key: string;
  /** The frame the cell shows wherever it has pixels. */
  pick: NaipCandidate;
  step: NaipPickStep;
  /**
   * The fallback stack, **excluding the pick**: the pick's alternates in the order the rule would
   * choose them if the pick were struck (first = the next choice). Every other leaf-on candidate —
   * every other candidate, for an off-season cell. Each shows through wherever everything above it
   * has no pixels (§2.2).
   */
  stack: readonly NaipCandidate[];
  /** Every state whose catalog lists this cell, sorted (two for a border cell). */
  states: readonly NaipState[];
}

/** Items dropped before the rule ran, by why (the run's counts, §2.1.3). */
export interface NaipSelectionDrops {
  /** Coarser than 0.6 m. */
  coarse: number;
  /** The quarter-quad lies outside its labeled state's envelope (§2.1.1). */
  outsideState: number;
  /** On the reviewed exclusion list (§2.1.2). */
  excluded: number;
}

/** The rule's answer over a whole catalog. */
export interface NaipSelection {
  /** One pick per quarter-quad with any candidate left, sorted by key. */
  picks: NaipCellPick[];
  dropped: NaipSelectionDrops;
  /**
   * Cells the off-season step reached that are **not** on the committed list, sorted. Their picks
   * are still in `picks`. The select stage refuses a build when this is non-empty (a seventh cell is
   * a look for the founder, never a silent foliage pick); the July check reports it instead.
   */
  offSeasonBeyondList: string[];
}

/**
 * The rule (§2.1), over every candidate of every state: drop the coarse, the mislabeled and the
 * excluded; then per cell, leaf-on only, the newest, a 0.3 m frame within two program years of the
 * newest beats it, and the off-season step where nothing is leaf-on. Independent of input order.
 */
export function selectNaipPicks(
  candidates: readonly NaipCandidate[],
  exclusions: readonly NaipExclusion[],
  offSeasonCells: readonly string[],
): NaipSelection {
  void candidates;
  void exclusions;
  void offSeasonCells;
  return placeholder('selectNaipPicks');
}

/** A cell's frame by reference: what a diff or an offer names. */
export interface NaipFrameRef {
  itemId: string;
  acquired: string;
  gsd: number;
  state: NaipState;
}

/** One cell whose pick or stack differs between the published manifest and a fresh selection. */
export interface NaipCellChange {
  key: string;
  /** The published pick; `null` for a cell the published build doesn't hold. */
  from: NaipFrameRef | null;
  /** The new pick; `null` for a cell the catalog no longer lists. */
  to: NaipFrameRef | null;
  /** True when the pick is the same frame and only the fallback stack changed. */
  stackOnly: boolean;
}

/** One state's share of a diff, by the new pick's labeled state (the old pick's for a removal). */
export interface NaipStateChange {
  state: NaipState;
  /** Changed cells in this state. */
  cells: number;
  /** The newest acquisition day among the changed cells' new picks; `null` if all were removals. */
  newest: string | null;
  /** The oldest published acquisition day those picks would replace; `null` if all were additions. */
  oldestReplaced: string | null;
}

/** What changed between the published build and the catalog now. Empty arrays: nothing changed. */
export interface NaipPickDiff {
  /** Every changed cell, sorted by key. */
  cells: NaipCellChange[];
  /** Per state, sorted by state code, only states with a change. */
  states: NaipStateChange[];
}

/**
 * The diff the July check offers and `--from-current` re-tiles (§3.1, §3.3): every cell whose pick or
 * fallback stack differs between the published manifest and `next`.
 */
export function diffNaipPicks(current: NaipManifest, next: readonly NaipCellPick[]): NaipPickDiff {
  void current;
  void next;
  return placeholder('diffNaipPicks');
}

function placeholder(fn: string): never {
  throw new Error(`PLACEHOLDER (S): naipSelection.${fn} is not built yet`);
}
