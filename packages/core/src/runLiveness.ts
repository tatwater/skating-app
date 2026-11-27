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
 *
 * PLACEHOLDER (B01-8a T0): the exports are the seam; the functions' bodies are S2's.
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

/** PLACEHOLDER (B01-8a T0): S2 writes the rule. */
export function runLiveness(_run: RunLivenessInput, _now: number): RunLiveness {
  throw new Error('runLiveness is not built yet');
}

/**
 * A campaign's: its running pass's liveness; between passes, the campaign row's own.
 *
 * PLACEHOLDER (B01-8a T0): S2 writes the rule.
 */
export function campaignLiveness(
  _campaign: RunLivenessInput,
  _passes: readonly RunLivenessInput[],
  _now: number,
): RunLiveness {
  throw new Error('campaignLiveness is not built yet');
}
