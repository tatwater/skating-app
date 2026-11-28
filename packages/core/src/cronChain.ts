/**
 * **A run that continues past its tick** (D349, B01-8c): a chained job (the weather appends, the gap
 * repair, the registry walk) opens its run before its first batch, every batch adds to it, and the
 * run closes when its last branch ends. `ChainState` is the run row's `chain` field; `chainLiveness`
 * is the one rule the card, the lane and the detail read it by.
 */

/** No step for this long reads *No word since …*: a batch of 40 requests takes a minute or two. */
export const CHAIN_QUIET_MS = 15 * 60_000;
/** The most lines one chained run keeps; past it the run counts `linesDropped`. */
export const CHAIN_LINES_MAX = 300;

/** A chained run's progress, as `cronRuns.chain` stores it. */
export interface ChainState {
  /** Branches still running; 0 = closed. */
  open: number;
  /** Batches reported so far. */
  steps: number;
  /** The last step's end. */
  progressAt: number;
  /** Lines kept so far (the cap's counter). */
  lines: number;
  linesDropped?: number;
}

/**
 * - `running` — a step ended inside {@link CHAIN_QUIET_MS};
 * - `quiet` — no word since, but a batch could still be alive;
 * - `stopped` — no word past `CRON_KILLED_AFTER_MS`: no batch can still be alive;
 * - `closed` — `open === 0`.
 */
export type ChainLiveness = 'running' | 'quiet' | 'stopped' | 'closed';

/**
 * A chained run's liveness at `now`.
 *
 * PLACEHOLDER (B01-8c-1 seams): `closed` at `open === 0`, else `running`; the chain's builder writes
 * the rule (`stopped` past core's `CRON_KILLED_AFTER_MS`) and its property tests.
 */
export function chainLiveness(chain: ChainState, _now: number): ChainLiveness {
  return chain.open === 0 ? 'closed' : 'running';
}
