/**
 * **The stall rule** (D341, B01-8a): whether a running import run is on time, late, stalled, or
 * held by *Wait 30 minutes* — one pure rule, read by the server (Machinery's sidebar tail, the
 * Overview's jobs card, Inbox Zero's line) and by the web (the ticking heartbeat), so the two can't
 * disagree.
 *
 * The rule: a row not `running`, or marked failed, is `finished`. A running row without
 * `progressAt` is `notRecorded`. With an expected gap *E* and quiet *q*: `running` while
 * *q* ≤ 2*E*, `late` while *q* ≤ 10*E*, else `stalled` — except that a stall inside a wait
 * (`now < stallWaitUntil`) reads `waiting`. A wait never changes `running` or `late`; it ends by
 * itself, and a beat clears the stall on its own. With no *E*, a running row is always `running`.
 */

const MINUTE = 60_000;

/** Late past 2× the expected gap (board `live-v5`, "late"). */
export const RUN_LATE_FACTOR = 2;
/** Stalled past 10× ("won't recover without a person"). */
export const RUN_STALLED_FACTOR = 10;
/** *Wait 30 minutes* (§5.5, 2026-10-17: a placeholder length, tuned with the gaps). */
export const RUN_WAIT_MS = 30 * MINUTE;

/**
 * The longest quiet a healthy run of each kind is expected to keep between beats, keyed by
 * `importRuns.kind`. Provisional: set from the beat cadence (60 s) plus a margin for one long step,
 * and from the one measured load (about 95 s per 25 batches, 2026-08-09); tuned from the first
 * campaign's events. A kind with no entry gets no verdict: its heartbeat is shown, never called late.
 */
export const RUN_QUIET_MS: Readonly<Record<string, number>> = {
  corpus_campaign: 3 * MINUTE, // between passes: a pnpm start and a Convex call
  region_masks: 2 * MINUTE,
  corpus_merge: 3 * MINUTE,
  canonical_water: 3 * MINUTE,
  sub_area_seed: 2 * MINUTE,
  landmark_match: 3 * MINUTE,
  landmark_seed: 2 * MINUTE,
  floor_prune: 3 * MINUTE,
  standing_seed: 3 * MINUTE,
  absorbed_retire: 3 * MINUTE,
};

export type RunLiveness =
  | { state: 'finished' }
  /** Running, but no `progressAt` (a row from before B01-7a). */
  | { state: 'notRecorded' }
  | {
      state: 'running' | 'late' | 'stalled' | 'waiting';
      /** now − progressAt, never negative (a clock ahead of the server reads 0). */
      quietMs: number;
      /** null: no verdict for this kind. */
      expectedMs: number | null;
      /** Set while `waiting`. */
      waitUntil: number | null;
    };

/** What the rule reads of a run: an `importRuns` row, with its wait flattened to `stallWaitUntil`. */
export interface RunLivenessInput {
  kind: string;
  status: 'running' | 'succeeded' | 'failed';
  progressAt?: number;
  markedFailed?: unknown;
  stallWaitUntil?: number;
}

/** The rung of a live verdict, best first: a campaign takes its worst running pass's. */
const RANK: Record<Exclude<RunLiveness['state'], 'finished'>, number> = {
  running: 0,
  notRecorded: 1,
  late: 2,
  waiting: 3,
  stalled: 4,
};

/** A kind's expected gap, or `null` for a kind with no verdict (own keys only: never `toString`). */
export function expectedQuietMs(kind: string): number | null {
  return Object.hasOwn(RUN_QUIET_MS, kind) ? (RUN_QUIET_MS[kind] as number) : null;
}

export function runLiveness(run: RunLivenessInput, now: number): RunLiveness {
  if (run.status !== 'running' || (run.markedFailed !== undefined && run.markedFailed !== null)) {
    return { state: 'finished' };
  }
  if (run.progressAt === undefined || !Number.isFinite(run.progressAt)) {
    return { state: 'notRecorded' };
  }
  const quietMs = Math.max(0, now - run.progressAt);
  const expectedMs = expectedQuietMs(run.kind);
  if (expectedMs === null) return { state: 'running', quietMs, expectedMs, waitUntil: null };
  if (quietMs <= RUN_LATE_FACTOR * expectedMs) {
    return { state: 'running', quietMs, expectedMs, waitUntil: null };
  }
  if (quietMs <= RUN_STALLED_FACTOR * expectedMs) {
    return { state: 'late', quietMs, expectedMs, waitUntil: null };
  }
  if (run.stallWaitUntil !== undefined && now < run.stallWaitUntil) {
    return { state: 'waiting', quietMs, expectedMs, waitUntil: run.stallWaitUntil };
  }
  return { state: 'stalled', quietMs, expectedMs, waitUntil: null };
}

/** Worse first: the higher rung, then the longer quiet. */
function worse(a: RunLiveness, b: RunLiveness): RunLiveness {
  if (a.state === 'finished') return b;
  if (b.state === 'finished') return a;
  const ra = RANK[a.state];
  const rb = RANK[b.state];
  if (ra !== rb) return ra > rb ? a : b;
  const qa = 'quietMs' in a ? a.quietMs : 0;
  const qb = 'quietMs' in b ? b.quietMs : 0;
  return qb > qa ? b : a;
}

/**
 * A campaign's: its running pass's liveness (the worst, if a killed pass was left running beside
 * the live one); between passes, the campaign row's own, quiet since whichever came last — the
 * campaign's own beat or a pass's last report (a pass's close stamps its `progressAt`), so a merge
 * that just finished after 45 minutes doesn't leave the campaign reading stalled. A finished or
 * marked campaign is finished, whatever its passes say.
 *
 * `rule` is the one-run rule it reads each row by: {@link runLiveness}, always, outside a story that
 * pins its own.
 */
export function campaignLiveness(
  campaign: RunLivenessInput,
  passes: readonly RunLivenessInput[],
  now: number,
  rule: (run: RunLivenessInput, now: number) => RunLiveness = runLiveness,
): RunLiveness {
  if (rule(campaign, now).state === 'finished') return { state: 'finished' };
  let live: RunLiveness = { state: 'finished' };
  for (const pass of passes) live = worse(live, rule(pass, now));
  if (live.state !== 'finished') return live;
  let progressAt = campaign.progressAt;
  for (const pass of passes) {
    if (pass.progressAt === undefined || !Number.isFinite(pass.progressAt)) continue;
    progressAt = progressAt === undefined ? pass.progressAt : Math.max(progressAt, pass.progressAt);
  }
  return rule(progressAt === undefined ? campaign : { ...campaign, progressAt }, now);
}
