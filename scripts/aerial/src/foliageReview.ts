/**
 * **The foliage review** (B05 §2.1.4, D319): score every candidate flown from 1 September, propose
 * the turned ones for striking by flight day, and lay out what each strike would do — for the
 * founder to confirm, mostly whole flight days at a time. `cli/foliage.ts` hands in the real world;
 * everything here takes it injected.
 *
 * **Nothing here strikes anything.** The proposal is a file beside the review sheet, every entry
 * `reviewedBy: 'proposed'`; the selection reads only core's `NAIP_FOLIAGE_STRIKES`, which an entry
 * joins by a reviewed commit once he has confirmed it, as the cloud review's do.
 *
 * - **The proposal**, per flight day (labeled state + acquisition day): a day where most of the
 *   scored frames read turned is one flight entry that keeps the rest by id; otherwise one frame
 *   entry per turned frame. Either way it strikes exactly the frames scoring under the threshold.
 *   Never proposed: a frame the cloud review kept on purpose (`NAIP_CLOUD_KEPT`), a frame a
 *   reviewed entry already names, or a frame not leaf-on by the calendar (striking an October
 *   frame changes nothing).
 * - **The impact**, from the rule run with and without it (`selectNaipPicks`): which cells change
 *   pick, to what, at what cost in sharpness and age, and which cells keep a turned frame because
 *   nothing green at 0.6 m or better is left (the off-season step's `allTurned`).
 */

import {
  isCoarseNaipFrame,
  isLeafOnNaipFrame,
  isNaipFlightStrike,
  isSharpNaipFrame,
  NAIP_CLOUD_KEPT,
  NAIP_EXCLUSIONS,
  NAIP_FOLIAGE_STRIKES,
  type NaipCandidate,
  type NaipCellPick,
  type NaipExclusion,
  type NaipFoliageStrike,
  type NaipOffSeasonWhy,
  type NaipSelection,
  type NaipState,
  naipFoliageStruck,
  quarterQuadCell,
  quarterQuadInState,
  selectNaipPicks,
} from '@skating/core';
import type { CatalogSnapshot } from './catalog';
import {
  FOLIAGE_TURNED_BELOW,
  type FoliageScore,
  type FoliageVerdict,
  foliageVerdict,
  greenShare,
  isFoliageScored,
} from './foliage';
import { StageRefusal } from './refusals';
import type { ScoreTarget } from './score';
import { checkSelection } from './selectChecks';

// ── The frames the screen judges ─────────────────────────────────────────────────────────────────

const midLat = (key: string) => quarterQuadCell(key).minLat + 1 / 32;

/** Is a frame leaf-on by the calendar, in its own cell? */
const leafOn = (f: NaipCandidate) => isLeafOnNaipFrame(f.acquired, midLat(f.key));

/** A frame's flight day: its labeled state and its acquisition day. */
export const flightDayOf = (f: Pick<NaipCandidate, 'state' | 'acquired'>) =>
  `${f.state} ${f.acquired}`;

/**
 * Every candidate the screen scores: in its labeled state, 0.6 m or better, not struck by the cloud
 * review, flown from 1 September — leaf-on or not, so the report can say what an October pick reads
 * as too. Once each, sorted by item id.
 */
export function foliageTargets(
  candidates: readonly NaipCandidate[],
  exclusions: readonly NaipExclusion[],
): NaipCandidate[] {
  const struck = new Set(exclusions.map((e) => e.itemId));
  const out = new Map<string, NaipCandidate>();
  for (const c of candidates) {
    if (out.has(c.itemId) || struck.has(c.itemId) || isCoarseNaipFrame(c.gsd)) continue;
    if (!quarterQuadInState(c.key, c.state) || !isFoliageScored(c.acquired)) continue;
    out.set(c.itemId, c);
  }
  return [...out.values()].sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
}

// ── The proposal ─────────────────────────────────────────────────────────────────────────────────

export interface ProposeOptions {
  threshold?: number;
  /** The proposal's day, `YYYY-MM-DD`. */
  proposedOn: string;
  /** The reviewed list: what it names is decided, and never proposed again. */
  reviewed?: readonly NaipFoliageStrike[];
  /** Frames never to propose (the cloud review's kept ones). */
  kept?: readonly string[];
}

/**
 * The proposed strikes, sorted by state, day and item id: a flight entry for a day where turned
 * frames are the majority of its scored, leaf-on frames (keeping the rest by id), frame entries
 * otherwise. Exactly the turned, unreviewed, leaf-on frames end up struck.
 */
export function proposeFoliageStrikes(
  targets: readonly NaipCandidate[],
  scores: ReadonlyMap<string, FoliageScore | null>,
  options: ProposeOptions,
): NaipFoliageStrike[] {
  const threshold = options.threshold ?? FOLIAGE_TURNED_BELOW;
  const reviewed = options.reviewed ?? NAIP_FOLIAGE_STRIKES;
  const kept = new Set(options.kept ?? NAIP_CLOUD_KEPT);
  const struck = naipFoliageStruck(reviewed);
  // Frames a reviewed entry names either way: struck, or kept by a reviewed flight entry's day.
  const decidedDays = new Set(
    reviewed.filter(isNaipFlightStrike).map((s) => flightDayOf(s.flight)),
  );
  const review = {
    reason: 'turned',
    reviewedBy: 'proposed',
    reviewedOn: options.proposedOn,
  } as const;

  const byDay = new Map<string, NaipCandidate[]>();
  for (const f of targets) {
    if (!leafOn(f) || struck(f) || decidedDays.has(flightDayOf(f))) continue;
    const day = flightDayOf(f);
    byDay.set(day, [...(byDay.get(day) ?? []), f]);
  }
  const out: NaipFoliageStrike[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const frames = byDay.get(day) as NaipCandidate[];
    const turned = frames.filter(
      (f) => !kept.has(f.itemId) && foliageVerdict(scores.get(f.itemId), threshold) === 'turned',
    );
    if (turned.length === 0) continue;
    const { state, acquired } = turned[0] as NaipCandidate;
    if (turned.length * 2 > frames.length) {
      const keep = frames.filter((f) => !turned.includes(f)).map((f) => f.itemId);
      out.push({
        flight: { state, acquired },
        keep,
        ...review,
        note: `${turned.length} of ${frames.length} frames read turned; the ${keep.length} kept do not`,
      });
    } else {
      for (const f of turned) out.push({ itemId: f.itemId, ...review });
    }
  }
  return out;
}

/** The proposal as written beside the sheet, and committed for the founder's review. */
export interface FoliageProposalFile {
  status: string;
  campaign: string;
  walkedOn: string;
  threshold: number;
  proposedOn: string;
  strikes: NaipFoliageStrike[];
}

export const PROPOSAL_STATUS =
  "PROPOSED, awaiting the founder's confirmation. Nothing here is struck: an entry is struck only once it is copied into core's NAIP_FOLIAGE_STRIKES with reviewedBy 'founder'.";

/** Reads a proposal file back, checking its shape; throws, saying what is wrong. */
export function readFoliageProposal(text: string): FoliageProposalFile {
  const file = JSON.parse(text) as FoliageProposalFile;
  if (!Array.isArray(file?.strikes)) throw new Error('a foliage proposal holds a strikes array');
  for (const s of file.strikes) {
    const named = isNaipFlightStrike(s)
      ? typeof s.flight?.state === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(s.flight.acquired ?? '') &&
        Array.isArray(s.keep)
      : typeof (s as { itemId?: unknown }).itemId === 'string';
    if (!named || s.reason !== 'turned' || !['founder', 'proposed'].includes(s.reviewedBy)) {
      throw new Error(`not a foliage strike: ${JSON.stringify(s)}`);
    }
  }
  return file;
}

// ── The impact ───────────────────────────────────────────────────────────────────────────────────

/** A frame as the review shows it. */
export interface ReviewFrame {
  itemId: string;
  key: string;
  state: NaipState;
  acquired: string;
  gsd: number;
  /** The green share, or `null`: unscored, not judged, or too little vegetation. */
  green: number | null;
  verdict: FoliageVerdict | 'notJudged';
}

/** One cell the proposal changes, or keeps on a turned frame. */
export interface ReviewCell {
  key: string;
  from: ReviewFrame;
  to: ReviewFrame;
  /** Set when the cell keeps a turned frame through the off-season step. */
  offSeason: NaipOffSeasonWhy | null;
}

/** Days between two `YYYY-MM-DD`, `a − b`. */
const daysBetween = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
const YEAR_DAYS = 365.25;

/** The cost of a set of changed cells: sharpness lost, age added. */
export interface ReviewCost {
  cells: number;
  /** Cells whose pick goes from 0.3 m to coarser. */
  sharpToCoarse: number;
  /** Mean years older over the changed cells (0 for none). */
  yearsOlder: number;
}

export function costOf(cells: readonly ReviewCell[]): ReviewCost {
  const changed = cells.filter((c) => c.from.itemId !== c.to.itemId);
  const days = changed.reduce((n, c) => n + daysBetween(c.from.acquired, c.to.acquired), 0);
  return {
    cells: changed.length,
    sharpToCoarse: changed.filter(
      (c) => isSharpNaipFrame(c.from.gsd) && !isSharpNaipFrame(c.to.gsd),
    ).length,
    yearsOlder: changed.length === 0 ? 0 : days / changed.length / YEAR_DAYS,
  };
}

/** One flight day on the sheet. */
export interface ReviewDay {
  state: NaipState;
  acquired: string;
  gsd: number;
  /** Its scored frames, by verdict. */
  counts: Record<FoliageVerdict, number>;
  /** What the proposal strikes of it: the whole day (keeping `keep`), or these frames. */
  proposal: { flight: true; keep: string[] } | { flight: false; frames: string[] } | null;
  /** A handful of its frames, from most turned to greenest. */
  samples: ReviewFrame[];
  /** Cells whose pick was this day's and changes. */
  changed: ReviewCell[];
  /** Cells whose pick is this day's and stays, turned, for want of a green frame. */
  keptOffSeason: ReviewCell[];
  /** Where the changed cells go: a flight (`ST YYYY-MM-DD gsd`) and how many. */
  fallsTo: { flight: string; cells: number }[];
  cost: ReviewCost;
}

/** A state's line in the summary. */
export interface ReviewStateRow {
  state: NaipState;
  cells: number;
  changed: number;
  sharpToCoarse: number;
  /** Mean years older over the changed cells. */
  yearsOlder: number;
  /** Mean pick age change over all the state's cells, years. */
  yearsOlderAll: number;
  /** After the proposal: picks by `YYYY · gsd m`, newest first. */
  mix: { flight: string; cells: number }[];
}

/** A pick that still reads turned after the proposal, and why. */
export interface StillTurned {
  key: string;
  pick: ReviewFrame;
  why: NaipOffSeasonWhy | 'cloudKept' | 'notProposed';
}

export interface FoliageReview {
  campaign: string;
  walkedOn: string;
  threshold: number;
  proposedOn: string;
  /** Frames judged, and how they read (unscored: no thumbnail). */
  scored: number;
  unscored: number;
  verdicts: Record<FoliageVerdict, number>;
  proposal: NaipFoliageStrike[];
  cellsTotal: number;
  states: ReviewStateRow[];
  total: ReviewCost;
  /** Days whose proposal changes a pick or keeps one turned, most cells first. */
  days: ReviewDay[];
  /** Days proposed for striking that change no pick (fallbacks only). */
  quietDays: ReviewDay[];
  /** Picks after the proposal scoring borderline, by day, with what striking them too would do. */
  borderline: { day: ReviewDay; picks: ReviewFrame[]; ifStruck: ReviewCost }[];
  /** Every cell the off-season step reaches after the proposal. */
  offSeason: { key: string; why: NaipOffSeasonWhy; pick: ReviewFrame }[];
  stillTurned: StillTurned[];
  /** The selections, for the caller's own checks. */
  before: NaipSelection;
  after: NaipSelection;
}

const VERDICTS: readonly FoliageVerdict[] = ['turned', 'borderline', 'green', 'noVerdict'];
const zeroCounts = () =>
  Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<FoliageVerdict, number>;
const gsdLabel = (gsd: number) => `${Math.round(gsd * 10) / 10}`;
export const flightLabel = (f: Pick<ReviewFrame, 'state' | 'acquired' | 'gsd'>) =>
  `${f.state} ${f.acquired} ${gsdLabel(f.gsd)} m`;

/** `n` items spread evenly over `items` (all of them when there are fewer), in order. */
export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  if (n <= 1) return items.slice(0, n);
  return Array.from(
    { length: n },
    (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))] as T,
  );
}

export interface FoliageReviewDeps {
  walk: () => Promise<CatalogSnapshot>;
  /** Scores frames (`foliagePixels` over their thumbnails); `null` for one that couldn't be. */
  score: (targets: readonly ScoreTarget[]) => Promise<Map<string, FoliageScore | null>>;
  log: (line: string) => void;
  now: () => Date;
  exclusions?: readonly NaipExclusion[];
  reviewed?: readonly NaipFoliageStrike[];
  kept?: readonly string[];
  /** The whole-catalog proof; injectable only so a test can make it fail. */
  check?: typeof checkSelection;
}

/** A review the stage won't hand over: the proposal broke the rule's invariants. */
export class FoliageRefusal extends StageRefusal {
  override name = 'FoliageRefusal';
}

/**
 * The whole review: walk, score, propose, and measure. Refuses (`FoliageRefusal`) when the rule run
 * with the proposal leaves a hole, breaks an invariant, or moves a frame the cloud review settled.
 */
export async function runFoliageReview(
  args: { campaign: string; threshold?: number },
  deps: FoliageReviewDeps,
): Promise<FoliageReview> {
  const threshold = args.threshold ?? FOLIAGE_TURNED_BELOW;
  const exclusions = deps.exclusions ?? NAIP_EXCLUSIONS;
  const reviewed = deps.reviewed ?? NAIP_FOLIAGE_STRIKES;
  const kept = deps.kept ?? NAIP_CLOUD_KEPT;
  const proposedOn = deps.now().toISOString().slice(0, 10);

  const snapshot = await deps.walk();
  const candidates = snapshot.items;
  const targets = foliageTargets(candidates, exclusions);
  deps.log(`[foliage] scoring ${targets.length} frames flown from 1 September`);
  const scores = await deps.score(
    targets.map((t) => ({
      itemId: t.itemId,
      thumbnail: (t as { thumbnail?: string | null }).thumbnail ?? null,
    })),
  );
  const proposal = proposeFoliageStrikes(targets, scores, {
    threshold,
    proposedOn,
    reviewed,
    kept,
  });
  const before = selectNaipPicks(candidates, exclusions, reviewed);
  const after = selectNaipPicks(candidates, exclusions, [...reviewed, ...proposal]);

  const check = (deps.check ?? checkSelection)(candidates, exclusions, after, [
    ...reviewed,
    ...proposal,
  ]);
  if (check.holes.length > 0 || check.violations.length > 0) {
    throw new FoliageRefusal(
      'foliage.breaksRule',
      `the proposal breaks the rule: ${[...check.holes.map((h) => `hole ${h}`), ...check.violations].slice(0, 10).join('; ')}`,
    );
  }
  // A frame the cloud review kept stays its cell's pick, whatever the foliage lists say: measured
  // against the rule with no foliage strike at all, so a reviewed entry can't move one either.
  const keptPicks = new Set(kept);
  const beforeByKey = new Map(before.picks.map((p) => [p.key, p]));
  const afterByKey = new Map(after.picks.map((p) => [p.key, p]));
  for (const p of selectNaipPicks(candidates, exclusions).picks) {
    if (keptPicks.has(p.pick.itemId) && afterByKey.get(p.key)?.pick.itemId !== p.pick.itemId) {
      throw new FoliageRefusal(
        'foliage.movesKept',
        `the foliage strikes move ${p.key}, whose pick the cloud review kept`,
      );
    }
  }

  const frame = (c: NaipCandidate): ReviewFrame => {
    const judged = isFoliageScored(c.acquired);
    const s = scores.get(c.itemId);
    return {
      itemId: c.itemId,
      key: c.key,
      state: c.state,
      acquired: c.acquired,
      gsd: c.gsd,
      green: judged && s != null ? greenShare(s) : null,
      verdict: judged ? foliageVerdict(s, threshold) : 'notJudged',
    };
  };
  const whyOf = new Map(after.offSeason.map((c) => [c.key, c.why]));
  const cells: ReviewCell[] = after.picks.map((p) => ({
    key: p.key,
    from: frame((beforeByKey.get(p.key) as NaipCellPick).pick),
    to: frame(p.pick),
    offSeason: whyOf.get(p.key) ?? null,
  }));

  // Per state, by the labeled state of the pick before.
  const states: ReviewStateRow[] = [];
  for (const state of [...new Set(cells.map((c) => c.from.state))].sort()) {
    const mine = cells.filter((c) => c.from.state === state);
    const cost = costOf(mine);
    const mix = new Map<string, number>();
    for (const c of cells.filter((c) => c.to.state === state)) {
      const label = `${c.to.acquired.slice(0, 4)} · ${gsdLabel(c.to.gsd)} m`;
      mix.set(label, (mix.get(label) ?? 0) + 1);
    }
    const allDays = mine.reduce((n, c) => n + daysBetween(c.from.acquired, c.to.acquired), 0);
    states.push({
      state,
      cells: mine.length,
      changed: cost.cells,
      sharpToCoarse: cost.sharpToCoarse,
      yearsOlder: cost.yearsOlder,
      yearsOlderAll: allDays / mine.length / YEAR_DAYS,
      mix: [...mix]
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .map(([flight, n]) => ({ flight, cells: n })),
    });
  }

  // Per flight day: every day with a scored leaf-on frame the proposal or a pick touches.
  const struckNow = naipFoliageStruck([...reviewed, ...proposal]);
  const dayFrames = new Map<string, NaipCandidate[]>();
  for (const t of targets.filter(leafOn)) {
    dayFrames.set(flightDayOf(t), [...(dayFrames.get(flightDayOf(t)) ?? []), t]);
  }
  const proposalOf = (day: string): ReviewDay['proposal'] => {
    const flight = proposal.find((s) => isNaipFlightStrike(s) && flightDayOf(s.flight) === day);
    if (flight !== undefined && isNaipFlightStrike(flight))
      return { flight: true, keep: [...flight.keep] };
    // Every day asked about holds a scored leaf-on frame: it came from `dayFrames`.
    const frames = (dayFrames.get(day) as NaipCandidate[])
      .filter((f) => proposal.some((s) => !isNaipFlightStrike(s) && s.itemId === f.itemId))
      .map((f) => f.itemId);
    return frames.length > 0 ? { flight: false, frames } : null;
  };
  const dayOf = (day: string): ReviewDay => {
    const frames = (dayFrames.get(day) as NaipCandidate[]).map(frame);
    const counts = zeroCounts();
    for (const f of frames) counts[f.verdict as FoliageVerdict]++;
    const changed = cells.filter(
      (c) => flightDayOf(c.from) === day && c.from.itemId !== c.to.itemId,
    );
    const keptOffSeason = cells.filter(
      (c) => flightDayOf(c.to) === day && c.offSeason === 'allTurned',
    );
    const fallsTo = new Map<string, number>();
    for (const c of changed)
      fallsTo.set(flightLabel(c.to), (fallsTo.get(flightLabel(c.to)) ?? 0) + 1);
    const byGreen = [...frames].sort(
      (a, b) => (a.green ?? 2) - (b.green ?? 2) || (a.itemId < b.itemId ? -1 : 1),
    );
    const turned = byGreen.filter((f) => f.verdict === 'turned');
    const rest = byGreen.filter((f) => f.verdict !== 'turned' && f.green !== null);
    const [state, acquired] = day.split(' ') as [NaipState, string];
    return {
      state,
      acquired,
      gsd: (frames[0] as ReviewFrame).gsd,
      counts,
      proposal: proposalOf(day),
      samples: [...spread(turned, 4), ...spread(rest, 2)],
      changed,
      keptOffSeason,
      fallsTo: [...fallsTo]
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
        .map(([flight, n]) => ({ flight, cells: n })),
      cost: costOf(changed),
    };
  };
  const proposedDays = new Set(
    [...dayFrames.entries()].filter(([, fs]) => fs.some((f) => struckNow(f))).map(([day]) => day),
  );
  const touched = [...proposedDays].map(dayOf);
  const order = (a: ReviewDay, b: ReviewDay) =>
    b.changed.length + b.keptOffSeason.length - (a.changed.length + a.keptOffSeason.length) ||
    (flightDayOf(a) < flightDayOf(b) ? -1 : 1);
  const days = touched.filter((d) => d.changed.length + d.keptOffSeason.length > 0).sort(order);
  const quietDays = touched
    .filter((d) => d.changed.length + d.keptOffSeason.length === 0)
    .sort(order);

  // Borderline picks: what striking them too would do, day by day.
  const borderlinePicks = cells.filter(
    (c) => c.to.verdict === 'borderline' && c.offSeason === null,
  );
  const borderline: FoliageReview['borderline'] = [];
  for (const day of [...new Set(borderlinePicks.map((c) => flightDayOf(c.to)))].sort()) {
    const picks = borderlinePicks.filter((c) => flightDayOf(c.to) === day).map((c) => c.to);
    const more: NaipFoliageStrike[] = picks.map((p) => ({
      itemId: p.itemId,
      reason: 'turned',
      reviewedBy: 'proposed',
      reviewedOn: proposedOn,
    }));
    const further = selectNaipPicks(candidates, exclusions, [...reviewed, ...proposal, ...more]);
    const furtherBy = new Map(further.picks.map((p) => [p.key, p]));
    const ifStruck = costOf(
      picks.map((p) => ({
        key: p.key,
        from: p,
        to: frame((furtherBy.get(p.key) as NaipCellPick).pick),
        offSeason: null,
      })),
    );
    borderline.push({ day: dayOf(day), picks, ifStruck });
  }
  borderline.sort(
    (a, b) => b.picks.length - a.picks.length || (flightDayOf(a.day) < flightDayOf(b.day) ? -1 : 1),
  );

  const pickFrame = new Map(cells.map((c) => [c.key, c.to]));
  const offSeason = after.offSeason.map((c) => ({
    ...c,
    pick: pickFrame.get(c.key) as ReviewFrame,
  }));
  const stillTurned: StillTurned[] = cells
    .filter((c) => c.to.verdict === 'turned')
    .map((c) => ({
      key: c.key,
      pick: c.to,
      why: c.offSeason ?? (keptPicks.has(c.to.itemId) ? 'cloudKept' : 'notProposed'),
    }));

  const verdicts = zeroCounts();
  let unscored = 0;
  for (const t of targets) {
    if (scores.get(t.itemId) == null) unscored++;
    verdicts[foliageVerdict(scores.get(t.itemId), threshold)]++;
  }
  return {
    campaign: args.campaign,
    walkedOn: snapshot.walkedOn,
    threshold,
    proposedOn,
    scored: targets.length - unscored,
    unscored,
    verdicts,
    proposal,
    cellsTotal: cells.length,
    states,
    total: costOf(cells),
    days,
    quietDays,
    borderline,
    offSeason,
    stillTurned,
    before,
    after,
  };
}

/** The proposal file for a review. */
export function proposalFile(review: FoliageReview): FoliageProposalFile {
  return {
    status: PROPOSAL_STATUS,
    campaign: review.campaign,
    walkedOn: review.walkedOn,
    threshold: review.threshold,
    proposedOn: review.proposedOn,
    strikes: review.proposal,
  };
}
