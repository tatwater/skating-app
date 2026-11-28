import {
  type CronCardState as CoreCronCardState,
  CRON_TICK_CODES,
  type CronLiveness,
  type CronLivenessInput,
  type CronSchedule,
  cronCardState as coreCronCardState,
  cronJobAt,
  cronLiveness,
  cronNextDueAt,
  foldCardState,
} from '@skating/core';

import type { CronJobView, CronLastRun, CronRunView, CronTickView } from './cronViews';

/**
 * **The cron pieces' one reading of a cron** — pure. The verdict is core's `cronLiveness`, re-read
 * on the web's ticking clock from the inputs the server sent with it (8a's pattern, `../liveness`):
 * one rule, so the card, the drawer's tabs, the lane and the Overview never disagree, and a cron
 * turns late on the second it does rather than at the next minute's answer. No threshold lives here.
 */

/** A cron's verdict at `now`, from the inputs its read carried. */
export function cronLivenessAt(
  job: { inputs: CronLivenessInput; schedule: CronSchedule },
  now: number,
): CronLiveness {
  return cronLiveness(job.inputs, job.schedule, now);
}

/**
 * What a cron's card says it is — core's `cronCardState`: the Overview's reading
 * (`cronJobState`, so the two pages agree), with a run cut off mid-way drawn as its own state
 * (*Cut off*) where the Overview folds it into *failed*. A run that failed or was cut off stays the
 * card's word through the quiet and running ticks after it, until a later run supersedes it; one a
 * machine host turned down reads *retried*.
 */
export type CronCardState = CoreCronCardState;
export const cronCardState = coreCronCardState;

/** The tone a state is drawn in: red needs a person, amber is late or retrying, live breathes. */
export type CronTone = 'bad' | 'warn' | 'live' | 'quiet' | 'hollow';

export const CRON_STATE_TONE: Record<CronCardState, CronTone> = {
  never: 'hollow',
  running: 'live',
  killed: 'bad',
  failed: 'bad',
  stalled: 'bad',
  late: 'warn',
  retried: 'warn',
  ok: 'quiet',
};

/**
 * When the card says it last ran (core's `cronJobAt`, the Overview's): the last run, when the state
 * is that run's; else the last tick, the start of the tick still running, or none.
 */
export function cronCardAt(
  liveness: CronLiveness,
  lastRun: CronLastRun,
  state: CronCardState,
): number | null {
  return cronJobAt(liveness, lastRun, foldCardState(state));
}

/**
 * A fixed-time cron's next run (ruling 17): the rule's `nextAt` once it has ticked, else the next
 * due time after `now`. `null` for an interval cron, whose phase is set at deploy and can't be read.
 */
export function cronNextAt(
  schedule: CronSchedule,
  liveness: CronLiveness,
  now: number,
): number | null {
  if ('every' in schedule) return null;
  const fromRule = 'nextAt' in liveness ? liveness.nextAt : null;
  // A due time already past (the job is late) is no next run to promise; name the one after now.
  if (fromRule !== null && fromRule > now) return fromRule;
  return cronNextDueAt(schedule, now);
}

/** Everything a card or a tab draws about a cron at `now`. */
export type CronReading = {
  liveness: CronLiveness;
  state: CronCardState;
  tone: CronTone;
  /** When it last ran, as the card says it (see {@link cronCardAt}). */
  at: number | null;
  /** A fixed-time cron's next run; `null` for an interval. */
  nextAt: number | null;
};

export function cronReading(job: CronJobView, now: number): CronReading {
  const liveness = cronLivenessAt(job, now);
  const state = cronCardState(liveness, job.lastRun);
  return {
    liveness,
    state,
    tone: CRON_STATE_TONE[state],
    at: cronCardAt(liveness, job.lastRun, state),
    nextAt: cronNextAt(job.schedule, liveness, now),
  };
}

// ── Ticks ────────────────────────────────────────────────────────────────────────────────────

/** A tick's kind, from its packed code (core's `CRON_TICK_CODES`). */
export type TickKind = 'quiet' | 'worked' | 'failed' | 'killed' | 'refused';

const KIND_OF_CODE = new Map<number, TickKind>([
  [CRON_TICK_CODES.ok, 'quiet'],
  [CRON_TICK_CODES.worked, 'worked'],
  [CRON_TICK_CODES.failed, 'failed'],
  [CRON_TICK_CODES.killed, 'killed'],
  [CRON_TICK_CODES.refused, 'refused'],
]);

/** A code the web doesn't know (a later outcome) reads as work done, never as quiet. */
export const tickKind = (code: number): TickKind => KIND_OF_CODE.get(code) ?? 'worked';

/** The legend's order, the quiet first. */
export const TICK_KINDS: readonly TickKind[] = ['worked', 'quiet', 'refused', 'failed', 'killed'];

/** The ticks oldest first, whatever order they came in (a row is in recorded order). */
export function sortTicks(ticks: readonly CronTickView[]): CronTickView[] {
  return [...ticks].filter((t) => Number.isFinite(t.at)).sort((a, b) => a.at - b.at);
}

/** How many of each kind. */
export function tickCounts(ticks: readonly CronTickView[]): Record<TickKind, number> {
  const out: Record<TickKind, number> = { quiet: 0, worked: 0, failed: 0, killed: 0, refused: 0 };
  for (const t of ticks) out[tickKind(t.code)] += 1;
  return out;
}

/** A tick placed on the strip: its whole-pixel offset from the left. */
export type TickMark = CronTickView & { kind: TickKind; x: number };

/**
 * Each tick's place on a strip `width` wide spanning `from`–`to`, oldest first: by its time,
 * snapped to a whole pixel and held inside the strip (a tick at `to` sits on the last pixel).
 */
export function placeTicks(
  ticks: readonly CronTickView[],
  from: number,
  to: number,
  width: number,
): TickMark[] {
  const span = Math.max(1, to - from);
  const last = Math.max(0, Math.floor(width) - 1);
  return sortTicks(ticks)
    .filter((t) => t.at >= from && t.at <= to)
    .map((t) => ({
      ...t,
      kind: tickKind(t.code),
      x: Math.min(last, Math.max(0, Math.floor(((t.at - from) / span) * width))),
    }));
}

/**
 * The tick a pointer at `x` is on: the nearest by pixel, and of two on the same pixel the one that
 * says more (a failure over a quiet tick), then the newer. `null` when none is within `reach`.
 */
export function tickAt(marks: readonly TickMark[], x: number, reach = 6): TickMark | null {
  let best: TickMark | null = null;
  let bestD = Infinity;
  for (const m of marks) {
    const d = Math.abs(m.x - x);
    if (d > reach) continue;
    // At the same distance the louder wins; only between equals does the newer.
    const louder = best !== null && weight(m.kind) > weight(best.kind);
    const newerEqual = best !== null && weight(m.kind) === weight(best.kind) && m.at > best.at;
    if (d < bestD || (d === bestD && (louder || newerEqual))) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

const WEIGHT: Record<TickKind, number> = { quiet: 0, worked: 1, refused: 2, failed: 3, killed: 4 };
const weight = (k: TickKind) => WEIGHT[k];

// ── The runs list, with its quiet ticks folded ───────────────────────────────────────────────

/** A row of the runs list: a run, or the quiet ticks between two runs folded into one line. */
export type RunsListRow =
  | { kind: 'run'; run: CronRunView }
  | { kind: 'quiet'; count: number; from: number; to: number };

/** A tick and a run are one when they started in the same second (ticks are kept to the second). */
const sameStart = (tick: number, run: number) => Math.abs(tick - run) < 1_000;

/**
 * **The runs with the quiet ticks between them folded** (ruling 15: no row per quiet tick). The runs
 * are newest first; each stretch of quiet ticks between two of them (and above the newest) becomes
 * one line with its count and its first and last tick. Ticks older than the oldest run listed are
 * folded only once the list is `complete` — until then, older runs may still land among them. A
 * quiet tick that started in a run's second is that run (a press that found nothing is a run row).
 */
export function foldQuiet(
  runs: readonly CronRunView[],
  ticks: readonly CronTickView[],
  complete: boolean,
): RunsListRow[] {
  const runStarts = runs.map((r) => r.startedAt);
  const quiet = sortTicks(ticks)
    .filter((t) => tickKind(t.code) === 'quiet')
    .filter((t) => !runStarts.some((s) => sameStart(t.at, s)))
    .reverse(); // newest first, as the runs are
  const rows: RunsListRow[] = [];
  let q = 0;
  const flush = (after: number) => {
    // Every quiet tick newer than `after`, from where the last fold stopped.
    const start = q;
    while (q < quiet.length && (quiet[q] as CronTickView).at > after) q += 1;
    if (q > start) {
      const stretch = quiet.slice(start, q);
      rows.push({
        kind: 'quiet',
        count: stretch.length,
        from: (stretch.at(-1) as CronTickView).at,
        to: (stretch[0] as CronTickView).at,
      });
    }
  };
  for (const run of runs) {
    flush(run.startedAt);
    rows.push({ kind: 'run', run });
  }
  if (complete || runs.length === 0) flush(-Infinity);
  return rows;
}

/** Whether a run's log opens by itself: a failed or killed run's does, a successful one's doesn't. */
export const opensByItself = (run: Pick<CronRunView, 'outcome'>) =>
  run.outcome === 'failed' || run.outcome === 'killed';

/** How many failed runs open their logs by themselves at once (each open log is a read). */
export const MAX_OPEN_BY_ITSELF = 3;

/** The tone a run's row is drawn in. */
export function runTone(run: Pick<CronRunView, 'outcome'>): 'bad' | 'warn' | 'quiet' {
  if (run.outcome === 'failed' || run.outcome === 'killed') return 'bad';
  if (run.outcome === 'refused' || run.outcome === 'capped') return 'warn';
  return 'quiet';
}
