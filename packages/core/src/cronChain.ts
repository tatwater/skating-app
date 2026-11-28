/**
 * **A run that continues past its tick** (D349, B01-8c): a chained job (the weather appends, the gap
 * repair, the registry walk) opens its run before its first batch, every batch adds to it, and the
 * run closes when its last branch ends. `ChainState` is the run row's `chain` field; `chainLiveness`
 * is the one rule the card, the lane, the detail and `cronRuns.openRun` read it by.
 *
 * The pure halves of `cronRuns.chainStep` live here too, so their rules are property-tested in one
 * place: how a step's counts fold into the run's ({@link mergeChainCounts}), how its failures by cause
 * fold ({@link mergeCauseTallies}, in `fetchFailure.ts`), and which lines a run keeps
 * ({@link planChainLines}).
 */

import { CRON_KILLED_AFTER_MS } from './cronLiveness';

/** No step for this long reads *No word since …*: a batch of 40 requests takes a minute or two. */
export const CHAIN_QUIET_MS = 15 * 60_000;
/** The most lines one chained run keeps; past it the run counts `linesDropped`. */
export const CHAIN_LINES_MAX = 300;
/**
 * The lines a chained run keeps from its start; the rest of {@link CHAIN_LINES_MAX} is a rolling
 * window over its newest lines, so a long run's log keeps both how it began and how it ended, with
 * the middle dropped (and counted).
 */
export const CHAIN_LINES_HEAD = 200;
/** The newest lines a chained run keeps past its head: its end is always among them. */
export const CHAIN_LINES_TAIL = CHAIN_LINES_MAX - CHAIN_LINES_HEAD;

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
 * A chained run's liveness at `now`: `closed` at `open ≤ 0`; else by the quiet since its last step
 * (`now − progressAt`, never negative, so a clock behind the server reads `running`) — `running` up
 * to {@link CHAIN_QUIET_MS}, `quiet` up to `CRON_KILLED_AFTER_MS`, `stopped` past it.
 *
 * Why `stopped` is safe to act on (`openRun` closes such a run `killed`): every batch starts after
 * the step that scheduled it stamped `progressAt`, and no action outlives `CONVEX_ACTION_LIMIT_MS`,
 * so past the limit and a minute of slack (for the scheduler's start delay) no batch of the run is
 * still alive. This is 8b's age rule for a manual stamp, and only that: 8b's other rule (a cron tick
 * calls a cron stamp dead at any age, since Convex never overlaps a cron with itself) does not carry
 * over, because a chain's later batches are scheduled actions, not the cron, and may overlap anything.
 */
export function chainLiveness(chain: ChainState, now: number): ChainLiveness {
  if (!(chain.open > 0)) return 'closed';
  const quietMs = Math.max(0, now - chain.progressAt);
  if (quietMs > CRON_KILLED_AFTER_MS) return 'stopped';
  if (quietMs > CHAIN_QUIET_MS) return 'quiet';
  return 'running';
}

/**
 * **How a step's counts fold into the run's**, key by key, by the key's name:
 *
 * - a key ending in `Max` (`fetchMsMax`) keeps the larger;
 * - a key ending in `Min`, or starting with `oldest` (`oldestOpenDay`), keeps the smaller;
 * - every other key is a tally, and adds.
 *
 * Each is commutative and associative, so the run's counts don't depend on the order its batches (or
 * its branches) report in. A count that isn't a finite number is dropped; at most `maxKeys` keys are
 * kept (the run's, then the step's new ones in order).
 */
export function mergeChainCounts(
  into: Readonly<Record<string, number>> | undefined,
  add: Readonly<Record<string, number>> | undefined,
  maxKeys = Number.POSITIVE_INFINITY,
): Record<string, number> {
  const out: Record<string, number> = { ...into };
  let n = Object.keys(out).length;
  for (const [key, value] of Object.entries(add ?? {})) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const had = out[key];
    if (had === undefined) {
      if (n >= maxKeys) continue;
      out[key] = value;
      n++;
    } else out[key] = foldCount(key, had, value);
  }
  return out;
}

/** How two values of one count combine: by its name, as {@link mergeChainCounts} says. */
export function foldCount(key: string, a: number, b: number): number {
  if (key.endsWith('Max')) return Math.max(a, b);
  if (key.endsWith('Min') || key.startsWith('oldest')) return Math.min(a, b);
  return a + b;
}

/** What {@link planChainLines} decides for one step's lines. */
export interface ChainLinesPlan {
  /** The incoming lines to insert, by index into the step's lines, each with its `seq`. */
  insert: { index: number; seq: number }[];
  /** Delete the run's stored lines with `seq` in `[from, to)` (the oldest of the tail), or none. */
  drop: { from: number; to: number } | null;
  /** The chain's `lines` and `linesDropped` after the step. */
  lines: number;
  linesDropped: number;
}

/**
 * **Which lines a chained run keeps.** A run's lines are numbered in the order they arrive (`seq`,
 * 0, 1, …, never reused). It keeps the first {@link CHAIN_LINES_HEAD} and the newest
 * {@link CHAIN_LINES_TAIL}, so at most {@link CHAIN_LINES_MAX}, and its last line always; the
 * middle is dropped and counted (`linesDropped`).
 *
 * Given the run's counters before the step and how many lines the step brings, the plan says which
 * of those to insert (with their `seq`) and which stored range to delete: at most
 * {@link CHAIN_LINES_MAX} inserts and {@link CHAIN_LINES_TAIL} deletes a step, whatever it sends.
 */
export function planChainLines(
  chain: Pick<ChainState, 'lines' | 'linesDropped'>,
  incoming: number,
): ChainLinesPlan {
  const kept = Math.max(0, chain.lines);
  const dropped = Math.max(0, chain.linesDropped ?? 0);
  const before = kept + dropped;
  const total = before + Math.max(0, incoming);
  if (total <= CHAIN_LINES_MAX) {
    return {
      insert: Array.from({ length: total - before }, (_, index) => ({
        index,
        seq: before + index,
      })),
      drop: null,
      lines: total,
      linesDropped: 0,
    };
  }
  /** Every seq from here on is in the tail's window. */
  const tailFrom = total - CHAIN_LINES_TAIL;
  const insert: { index: number; seq: number }[] = [];
  for (let index = 0; index < total - before; index++) {
    const seq = before + index;
    if (seq < CHAIN_LINES_HEAD || seq >= tailFrom) insert.push({ index, seq });
  }
  // Stored lines in [HEAD, tailFrom) fall out of the window: only ones stored before this step.
  const dropTo = Math.min(tailFrom, before);
  return {
    insert,
    drop: dropTo > CHAIN_LINES_HEAD ? { from: CHAIN_LINES_HEAD, to: dropTo } : null,
    lines: CHAIN_LINES_MAX,
    linesDropped: total - CHAIN_LINES_MAX,
  };
}
