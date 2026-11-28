/**
 * **Which NAIP frame each quarter-quad shows** in the summer aerial (B05 §2.1, D315).
 *
 * One rule, two callers: the select stage (`scripts/aerial`) builds the archive's manifest with it,
 * and the July reassessment (Convex) re-runs it on the live catalog and diffs the answer against the
 * published manifest. It lives here so the two can never disagree about what a good frame is.
 *
 * The rule's order is total (newest acquisition, then sharper, then item id), so the same catalog
 * always gets the same answer, whatever order the walk returned it in.
 */

import { quarterQuadCell, quarterQuadInState } from './naipGrid';
import type { NaipManifest } from './naipManifest';

/**
 * The rule's version, stamped into every manifest. Bump it whenever the rule could pick a different
 * frame for the same catalog, so a manifest says which rule built it and a partial rebuild never
 * mixes two rules' picks under one input hash.
 *
 * 2 (2026-11-27, D319): the reviewed foliage strikes, and the off-season step by rule rather than by
 * a committed list of cells.
 */
export const NAIP_RULE_VERSION = 2;

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
 * A flight or a frame struck by the founder's foliage review (§2.1.4, D319): flown leaf-on by the
 * calendar, but already in autumn color or brown. Never by score alone: the screen
 * (`scripts/aerial`'s `foliage.ts`) only proposes, and a person confirms.
 *
 * A struck frame is **demoted, not dropped**: it is never a cell's pick while the cell has a
 * leaf-on frame that isn't struck, and it sits below every such frame in the fallback stack, so it
 * shows only where nothing green has pixels — autumn imagery rather than a hole.
 */
interface NaipFoliageStrikeReview {
  reason: 'turned';
  /**
   * `founder` once he has confirmed it; `proposed` for the screen's proposal awaiting him. The select
   * stage refuses to build (anything but a dry run) with a `proposed` entry.
   */
  reviewedBy: 'founder' | 'proposed';
  /** The review's day (the proposal's, for a `proposed` entry), `YYYY-MM-DD`. */
  reviewedOn: string;
  /** Why, in a few words, when it isn't obvious. */
  note?: string;
}

/**
 * One whole flight day, as the founder mostly reviews them: every frame the catalog labels `state`
 * and dates `acquired`, except the frames in `keep` (a per-frame exception: a green frame on a
 * turned day).
 */
export interface NaipFlightStrike extends NaipFoliageStrikeReview {
  flight: { state: NaipState; acquired: string };
  /** Item ids of that flight day that are not struck, sorted. */
  keep: readonly string[];
}

/** One frame (the other per-frame exception: a turned frame on a day not struck whole). */
export interface NaipFrameStrike extends NaipFoliageStrikeReview {
  itemId: string;
}

export type NaipFoliageStrike = NaipFlightStrike | NaipFrameStrike;

/** Does this strike name a whole flight day? */
export function isNaipFlightStrike(strike: NaipFoliageStrike): strike is NaipFlightStrike {
  return 'flight' in strike;
}

/**
 * The reviewed list as a test of one frame: is it struck? A frame is struck when a frame entry names
 * it, or a flight entry names its labeled state and acquisition day and doesn't keep it.
 */
export function naipFoliageStruck(
  strikes: readonly NaipFoliageStrike[],
): (frame: Pick<NaipCandidate, 'itemId' | 'state' | 'acquired'>) => boolean {
  const frames = new Set<string>();
  const flights = new Map<string, Set<string>>();
  for (const s of strikes) {
    if (!isNaipFlightStrike(s)) {
      frames.add(s.itemId);
      continue;
    }
    const day = `${s.flight.state} ${s.flight.acquired}`;
    // Two entries for one day keep only what both keep: each says "strike all of it but these".
    const before = flights.get(day);
    const keep = new Set(s.keep);
    flights.set(
      day,
      before === undefined ? keep : new Set([...before].filter((id) => keep.has(id))),
    );
  }
  return (f) => {
    if (frames.has(f.itemId)) return true;
    const keep = flights.get(`${f.state} ${f.acquired}`);
    return keep !== undefined && !keep.has(f.itemId);
  };
}

/**
 * Which step picked a cell's frame: `leafOn` (the rule's steps 2–4), or `offSeason` (step 5, a cell
 * with no leaf-on frame that isn't struck as turned).
 */
export type NaipPickStep = 'leafOn' | 'offSeason';

/**
 * Why a cell reached the off-season step: `noLeafOn`, nothing flown leaf-on at 0.6 m or better (the
 * six October cells north of Rumford); `allTurned`, every leaf-on frame struck as turned (western
 * Maine's 27 September 2023 cells).
 */
export type NaipOffSeasonWhy = 'noLeafOn' | 'allTurned';

/** A cell the off-season step reached: named in every run and manifest, for the July check. */
export interface NaipOffSeasonCell {
  key: string;
  why: NaipOffSeasonWhy;
}

/** One quarter-quad's answer. */
export interface NaipCellPick {
  /** The quarter-quad key. */
  key: string;
  /** The frame the cell shows wherever it has pixels. */
  pick: NaipCandidate;
  step: NaipPickStep;
  /**
   * The fallback stack, **excluding the pick**: the pick's alternates in the order the rule would
   * choose them if the pick were struck (first = the next choice). Every other leaf-on candidate,
   * those struck as turned last — every other candidate, for a cell with no leaf-on frame at all.
   * Each shows through wherever everything above it has no pixels (§2.2).
   */
  stack: readonly NaipCandidate[];
  /**
   * Every state whose catalog lists this cell with a candidate (a frame at 0.6 m or better, struck
   * or not), sorted — two for a border cell.
   */
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
  /** Candidates the foliage list strikes (demoted, not dropped). */
  foliageStruck: number;
  /**
   * Every cell the off-season step reached, with why, sorted by key: the known off-season cells.
   * Their picks are in `picks`; the manifest names them, so the July check can revisit them.
   */
  offSeason: NaipOffSeasonCell[];
}

// ── The rule's parts ──────────────────────────────────────────────────────────────────────────────

/**
 * The coarsest frame the archive takes, meters. NY 2017 and the older 1 m flights are coarser; a
 * frame at 0.5 m (NY 2015) is not, and stays a candidate.
 */
export const NAIP_MAX_GSD = 0.6;

/** A sharp frame (step 4): 0.3 m. */
export const NAIP_SHARP_GSD = 0.3;

/** Step 4's window: a sharp frame at most this many program years older than the newest wins. */
export const NAIP_SHARP_WINDOW_YEARS = 2;

/**
 * Leaf-on (step 2): 1 June to 30 September; from 20 May south of this latitude, read at the
 * quarter-quad's middle.
 */
export const NAIP_EARLY_LEAF_ON_SOUTH_OF = 43.5;

/**
 * The catalog's `gsd` carries float noise (`0.6000000000000024`); every comparison here is to the
 * centimeter, so a 0.6 m frame is never read as coarser than 0.6 m.
 */
const GSD_EPSILON = 0.005;

/** Is a frame coarser than the archive takes (step 1)? */
export function isCoarseNaipFrame(gsd: number): boolean {
  return gsd > NAIP_MAX_GSD + GSD_EPSILON;
}

/** Is a frame sharp, 0.3 m or finer (step 4)? */
export function isSharpNaipFrame(gsd: number): boolean {
  return gsd <= NAIP_SHARP_GSD + GSD_EPSILON;
}

/**
 * Was a frame flown leaf-on (step 2)? `acquired` is its `YYYY-MM-DD` day; `cellMidLat` the middle
 * of its quarter-quad. 1 June–30 September everywhere, and from 20 May south of 43.5°N.
 */
export function isLeafOnNaipFrame(acquired: string, cellMidLat: number): boolean {
  const monthDay = acquired.slice(5); // MM-DD sorts as the calendar does
  const opens = cellMidLat < NAIP_EARLY_LEAF_ON_SOUTH_OF ? '05-20' : '06-01';
  return monthDay >= opens && monthDay <= '09-30';
}

/**
 * Does `a` come before `b` in the rule's preference, before step 4? The newer acquisition first;
 * on the same day the sharper; then by item id, so the order is total and the answer never depends
 * on the input's order.
 */
function newerFirst(a: NaipCandidate, b: NaipCandidate): number {
  if (a.acquired !== b.acquired) return a.acquired > b.acquired ? -1 : 1;
  if (Math.abs(a.gsd - b.gsd) > GSD_EPSILON) return a.gsd - b.gsd;
  // Item ids are distinct by now (`selectNaipPicks` holds each once), so this never ties.
  return a.itemId < b.itemId ? -1 : 1;
}

/**
 * Steps 3 and 4 over one cell's frames: the newest, unless a sharp frame is at most two program
 * years older, in which case the newest such sharp frame. `frames` is non-empty.
 */
function bestOf(frames: readonly NaipCandidate[]): NaipCandidate {
  const sorted = [...frames].sort(newerFirst);
  const newest = sorted[0] as NaipCandidate;
  const sharp = sorted.find(
    (f) => isSharpNaipFrame(f.gsd) && f.year >= newest.year - NAIP_SHARP_WINDOW_YEARS,
  );
  return sharp ?? newest;
}

/**
 * A cell's frames in the rule's order: the pick, then what it would pick were that struck, and so
 * on — so the fallback stack is exactly "the next choice first". Step 4's window moves with the
 * newest frame left, which is why this re-applies the rule rather than sorting once.
 */
export function rankNaipFrames(frames: readonly NaipCandidate[]): NaipCandidate[] {
  const left = [...frames];
  const ranked: NaipCandidate[] = [];
  while (left.length > 0) {
    const best = bestOf(left);
    ranked.push(best);
    left.splice(left.indexOf(best), 1);
  }
  return ranked;
}

/**
 * The rule (§2.1), over every candidate of every state: drop the coarse, the mislabeled and the
 * excluded; then per cell, leaf-on only and not struck as turned, the newest, a 0.3 m frame within
 * two program years of the newest beats it. Where that leaves nothing, the off-season step: the
 * cell keeps the newest sharpest of its leaf-on frames, turned or not (`allTurned`), or of every
 * frame when none was flown leaf-on (`noLeafOn`). Independent of input order.
 *
 * A candidate listed twice (the same item id) counts once. A cell whose every frame is dropped has
 * no pick; the select stage counts that as a hole and refuses the build.
 */
export function selectNaipPicks(
  candidates: readonly NaipCandidate[],
  exclusions: readonly NaipExclusion[],
  foliageStrikes: readonly NaipFoliageStrike[] = [],
): NaipSelection {
  const struck = new Set(exclusions.map((e) => e.itemId));
  const turned = naipFoliageStruck(foliageStrikes);
  const dropped: NaipSelectionDrops = { coarse: 0, outsideState: 0, excluded: 0 };
  const byCell = new Map<string, { frames: Map<string, NaipCandidate>; states: Set<NaipState> }>();

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.itemId)) continue;
    seen.add(c.itemId);
    // Step 1, in this order: a mislabeled item is reported as such even when it is also coarse, so
    // the outside-state count is the catalog's mislabeling, whole.
    if (!quarterQuadInState(c.key, c.state)) {
      dropped.outsideState++;
      continue;
    }
    if (isCoarseNaipFrame(c.gsd)) {
      dropped.coarse++;
      continue;
    }
    let cell = byCell.get(c.key);
    if (cell === undefined) {
      cell = { frames: new Map(), states: new Set() };
      byCell.set(c.key, cell);
    }
    // A state lists the cell when it holds a candidate there, struck or not: only those compete
    // (an old 1 m flight across a state line lists nothing that could show).
    cell.states.add(c.state);
    // Exclusions before the season step (§2.1.2): a struck frame falls back to the next leaf-on one.
    if (struck.has(c.itemId)) {
      dropped.excluded++;
      continue;
    }
    cell.frames.set(c.itemId, c);
  }

  const picks: NaipCellPick[] = [];
  const offSeason: NaipOffSeasonCell[] = [];
  let foliageStruck = 0;
  for (const [key, { frames, states }] of byCell) {
    const all = [...frames.values()];
    if (all.length === 0) continue;
    const midLat = quarterQuadCell(key).minLat + 1 / 32;
    const leafOn = all.filter((f) => isLeafOnNaipFrame(f.acquired, midLat));
    const green = leafOn.filter((f) => !turned(f));
    const demoted = leafOn.filter((f) => turned(f));
    foliageStruck += all.filter((f) => turned(f)).length;
    let ranked: NaipCandidate[];
    if (green.length > 0) {
      // A struck frame stays under every green one: it shows only where they have no pixels.
      ranked = [...rankNaipFrames(green), ...rankNaipFrames(demoted)];
    } else if (leafOn.length > 0) {
      offSeason.push({ key, why: 'allTurned' });
      ranked = rankNaipFrames(leafOn);
    } else {
      offSeason.push({ key, why: 'noLeafOn' });
      ranked = rankNaipFrames(all);
    }
    const [pick, ...stack] = ranked as [NaipCandidate, ...NaipCandidate[]];
    const step: NaipPickStep = green.length > 0 ? 'leafOn' : 'offSeason';
    picks.push({ key, pick, step, stack, states: [...states].sort() });
  }

  // Keys are unique here (one pick per cell), so the order needs no tie.
  picks.sort((a, b) => (a.key < b.key ? -1 : 1));
  offSeason.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { picks, dropped, foliageStruck, offSeason };
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
  const published = new Map(current.cells.map((c) => [c.key, c]));
  const fresh = new Map(next.map((p) => [p.key, p]));
  const ref = (itemId: string): NaipFrameRef => {
    const frame = current.frames[itemId];
    if (frame === undefined) {
      throw new Error(`manifest ${current.campaign} names frame ${itemId} but doesn't hold it`);
    }
    return { itemId, acquired: frame.acquired, gsd: frame.gsd, state: frame.state };
  };
  const refOf = (c: NaipCandidate): NaipFrameRef => ({
    itemId: c.itemId,
    acquired: c.acquired,
    gsd: c.gsd,
    state: c.state,
  });

  const cells: NaipCellChange[] = [];
  for (const key of new Set([...published.keys(), ...fresh.keys()])) {
    const was = published.get(key);
    const now = fresh.get(key);
    if (was !== undefined && now !== undefined) {
      const sameStack =
        was.stack.length === now.stack.length &&
        was.stack.every((id, i) => id === now.stack[i]?.itemId);
      if (was.pick === now.pick.itemId && sameStack) continue;
      cells.push({
        key,
        from: ref(was.pick),
        to: refOf(now.pick),
        stackOnly: was.pick === now.pick.itemId,
      });
    } else if (was !== undefined) {
      cells.push({ key, from: ref(was.pick), to: null, stackOnly: false });
    } else {
      // The key came from one of the two maps, and not the published one.
      cells.push({ key, from: null, to: refOf((now as NaipCellPick).pick), stackOnly: false });
    }
  }
  cells.sort((a, b) => (a.key < b.key ? -1 : 1));

  const byState = new Map<NaipState, NaipStateChange>();
  for (const change of cells) {
    const state = (change.to ?? change.from)?.state as NaipState;
    const row = byState.get(state) ?? { state, cells: 0, newest: null, oldestReplaced: null };
    row.cells++;
    if (change.to && (row.newest === null || change.to.acquired > row.newest)) {
      row.newest = change.to.acquired;
    }
    if (change.from && (row.oldestReplaced === null || change.from.acquired < row.oldestReplaced)) {
      row.oldestReplaced = change.from.acquired;
    }
    byState.set(state, row);
  }
  const states = [...byState.values()].sort((a, b) => (a.state < b.state ? -1 : 1));
  return { cells, states };
}
