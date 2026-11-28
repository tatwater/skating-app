/**
 * **A cron's card state** (B01-8b): the one mapping from core's `cronLiveness` verdict and a cron's
 * last run to the state a card draws — shared by the Overview's Machinery card (`machinery.ts`), the
 * Imagery lane (`machineryImagery.imageryLaneTail`) and the web's cron card, so the pages can't
 * disagree. It folds a killed tick into `failed` (the Overview's reading); Machinery's own cron card
 * draws `killed` as its own state (the governor's ruling, 2026-11-28), reading the verdict first.
 * Moved from `packages/convex/convex/machinery.ts` unchanged in behavior (B01-8b-2).
 */

import type { CronLiveness } from './cronLiveness';

/** A cron's last run as the mapping reads it: the newest tick that did work or failed. */
export type CronLastRun = { startedAt: number; outcome: string } | null;

/**
 * A job's last word, worst first — the card's order. `running` is a corpus run reporting on time
 * (shown, so the card says the campaign is going); `never` hasn't run this season.
 */
export const JOB_STATES = [
  'stalled',
  'failed',
  'late',
  'retried',
  'running',
  'ok',
  'never',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** A last run that failed or was killed: the card stays failed until a later run supersedes it. */
const lastRunFailed = (lastRun: CronLastRun) =>
  lastRun?.outcome === 'failed' || lastRun?.outcome === 'killed';

/**
 * A cron's card state, from core's verdict — the one Machinery's cron cards draw, so the two can't
 * disagree on lateness. A tick killed mid-run is failed (it needs a look). On time, the card also
 * reads the cron's **last run** (the newest tick that did work or failed, `lastRunId`), as it read
 * the newest `imageryRuns` row before the backbone: a run that failed or was killed stays failed
 * until a later run supersedes it — so the pump's failure doesn't flip to ok on the quiet tick three
 * minutes on, while it backs off for half an hour — and one a machine host turned down (the pump
 * backing off) reads retried. `never` is a cron with no tick recorded yet — right after the deploy that began
 * recording, before its first tick (the pump's within three minutes, the poll's within six hours,
 * whether or not the history copy has run) — which the card draws quiet, with no time, never red,
 * and never counts as ok.
 */
export function cronJobState(liveness: CronLiveness, lastRun: CronLastRun): JobState {
  switch (liveness.state) {
    case 'killed':
      return 'failed';
    case 'running':
      // A tick under way hasn't superseded a failed run yet: the pump backing off from one starts
      // (and skips) a tick every three minutes, and the card must not flicker off failed for each.
      return lastRunFailed(lastRun) ? 'failed' : 'running';
    case 'ok':
      if (lastRunFailed(lastRun)) return 'failed';
      return lastRun?.outcome === 'refused' ? 'retried' : 'ok';
    default:
      return liveness.state;
  }
}

/**
 * When the row says it last ran: the last run, when the row's state is that run's (a failed or
 * refused one the ticks since haven't superseded); else the last tick, the start of the tick still
 * running, or none.
 */
export function cronJobAt(
  liveness: CronLiveness,
  lastRun: CronLastRun,
  state: JobState,
): number | null {
  if (lastRun !== null && (state === 'failed' || state === 'retried')) {
    if (liveness.state === 'running' || liveness.state === 'ok') return lastRun.startedAt;
  }
  if (liveness.state === 'running' || liveness.state === 'killed') return liveness.since;
  if (liveness.state === 'never') return null;
  return liveness.lastTickAt;
}

/**
 * **Machinery's own cron card** (B01-8b-2): the Overview's reading, with one difference the governor
 * ruled (2026-11-28) — a run cut off mid-way is drawn as its own state (*Cut off*), where the
 * Overview's row folds it into `failed`. Cut off is a tick the rule calls killed now, or a last run
 * recorded killed that no later run has superseded; everything else is {@link cronJobState}'s answer,
 * so the card, the lane and the Overview agree on every other state at the same `now`.
 */
export type CronCardState = JobState | 'killed';

export function cronCardState(liveness: CronLiveness, lastRun: CronLastRun): CronCardState {
  if (liveness.state === 'killed') return 'killed';
  const state = cronJobState(liveness, lastRun);
  return state === 'failed' && lastRun?.outcome === 'killed' ? 'killed' : state;
}

/** The Overview's state a card state folds into (`killed` → `failed`): the one comparison point. */
export const foldCardState = (state: CronCardState): JobState =>
  state === 'killed' ? 'failed' : state;

/**
 * **The worst of a pipeline's crons** (the Imagery lane's tail, on the server and the web): each
 * cron's {@link cronJobState}, worst first by {@link JOB_STATES} (so `never` ranks below `ok`: a cron
 * not yet recorded never outranks one that is), dated by {@link cronJobAt}; among equals, the newest
 * time. No crons is `never`.
 */
export function worstCronJob(jobs: readonly { liveness: CronLiveness; lastRun: CronLastRun }[]): {
  state: JobState;
  at: number | null;
} {
  let worst: { state: JobState; at: number | null } = { state: 'never', at: null };
  for (const job of jobs) {
    const state = cronJobState(job.liveness, job.lastRun);
    const at = cronJobAt(job.liveness, job.lastRun, state);
    const rank = JOB_STATES.indexOf(state);
    const was = JOB_STATES.indexOf(worst.state);
    if (rank < was || (rank === was && (at ?? 0) > (worst.at ?? 0))) worst = { state, at };
  }
  return worst;
}
