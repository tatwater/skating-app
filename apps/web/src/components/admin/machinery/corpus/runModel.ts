import type { Id } from '@skating/convex/dataModel';
import { CORPUS_RUN_PLAN } from '@skating/core';
import { CORE_RULE, type LivenessRule, livenessAt } from '../liveness';
import { PASS_STATE_WORDS, RUN_WORDS, STATE_WORDS, TAIL_WORDS } from '../words/runWords';
import { clock, clockSeconds, everyWords, quietWords } from './runFormat';
import type { CampaignView, LivenessView, PassRowView, RunView } from './runViews';

/**
 * **What the run pages read off a view** — pure, with the clock passed in, so a story pins every
 * age and every late or stalled mark. Every verdict is Machinery's one re-reading of core's stall
 * rule (`../liveness`), the one the run list reads too, against the page's ticking clock, so the
 * heartbeat moves between the server's minute-rounded answers; a view the server sent no inputs for
 * keeps the server's.
 */

export { CORE_RULE, type LivenessRule };

/**
 * The campaign's running pass: `current` while its run hasn't closed. (`current` is the last pass
 * that ran when nothing is running, so between passes and after the end this is `null`.)
 */
export function runningPass(
  view: Pick<CampaignView, 'current' | 'passes'>,
): NonNullable<CampaignView['current']> | null {
  const current = view.current;
  if (current === null) return null;
  const row = view.passes.find((p) => p.run?.id === current.runId);
  return row?.run?.finishedAt === null ? current : null;
}

/** The `importRuns.kind` a pass's row is written under (`null` for a name no plan knows). */
export function kindOfPass(pass: string): string | null {
  return CORPUS_RUN_PLAN.find((p) => p.pass === pass)?.kind ?? null;
}

/** A campaign's liveness at `now`: its row's, re-read as the list re-reads it. */
export function campaignLivenessAt(
  view: Pick<CampaignView, 'row'>,
  now: number,
  rule: LivenessRule = CORE_RULE,
): LivenessView {
  return livenessAt(view.row, now, rule);
}

/** One run's liveness at `now`, re-read from the inputs the server sent with it. */
export function runLivenessAt(
  view: Pick<RunView, 'liveness' | 'livenessInputs'>,
  now: number,
  rule: LivenessRule = CORE_RULE,
): LivenessView {
  return livenessAt(
    { kind: 'pass', liveness: view.liveness, livenessInputs: view.livenessInputs ?? null },
    now,
    rule,
  );
}

/** The tone everything about a run's state shares: the badge, the heartbeat, the bar's segment. */
export type RunTone = 'live' | 'warn' | 'bad' | 'quiet';

/** A run's head badge: its words, its tone and whether it is a running (live) state. */
export type HeadBadge = { words: string; tone: RunTone };

/**
 * The head's state badge: *Stalled · 41 min quiet*, *Late · 6 min quiet*, *Running*, *Waiting
 * until 14:42*, *No heartbeat recorded*, *Marked failed · 14:20*, *Succeeded*, *Failed*.
 */
export function headBadge(
  liveness: LivenessView,
  status: 'running' | 'succeeded' | 'failed',
  markedAt: number | null,
  timeZone?: string,
): HeadBadge {
  if (markedAt !== null) {
    return { words: RUN_WORDS.markedAt(clock(markedAt, timeZone)), tone: 'bad' };
  }
  switch (liveness.state) {
    case 'running':
      return { words: STATE_WORDS.running, tone: 'live' };
    case 'late':
      return {
        words: `${STATE_WORDS.late} · ${RUN_WORDS.quiet(quietWords(liveness.quietMs))}`,
        tone: 'warn',
      };
    case 'stalled':
      return {
        words: `${STATE_WORDS.stalled} · ${RUN_WORDS.quiet(quietWords(liveness.quietMs))}`,
        tone: 'bad',
      };
    case 'waiting':
      return {
        words:
          liveness.waitUntil === null
            ? STATE_WORDS.waiting
            : RUN_WORDS.waitingUntil(clock(liveness.waitUntil, timeZone)),
        tone: 'warn',
      };
    case 'notRecorded':
      return { words: STATE_WORDS.notRecorded, tone: 'warn' };
    case 'finished':
      return status === 'failed'
        ? { words: STATE_WORDS.failed, tone: 'bad' }
        : status === 'succeeded'
          ? { words: STATE_WORDS.succeeded, tone: 'quiet' }
          : // Finished by the rule but still `running` on the row: a mark the view didn't carry.
            { words: STATE_WORDS.running, tone: 'live' };
  }
}

/** A segment of the stage bar. */
export type SegmentTone =
  | 'done'
  | 'running'
  | 'late'
  | 'stalled'
  | 'waiting'
  | 'failed'
  | 'dead'
  | 'idle';

export type Segment = { pass: string; by: 'script' | 'hand'; tone: SegmentTone };

/**
 * The stage bar: one segment a planned pass, the by-hand passes after a gap. A done pass is the
 * quiet fill; the running one takes the campaign's liveness (ice running, amber late or held, red
 * stalled); a failed one is red, or spent when the campaign was marked failed by hand; once the
 * campaign has ended, a pass it never reached is spent.
 */
export function stageSegments(
  passes: readonly PassRowView[],
  liveness: LivenessView,
  ended: boolean,
  marked: boolean,
): Segment[] {
  const running: SegmentTone =
    liveness.state === 'late'
      ? 'late'
      : liveness.state === 'stalled'
        ? 'stalled'
        : liveness.state === 'waiting'
          ? 'waiting'
          : 'running';
  return passes.map((p) => {
    const tone = ((): SegmentTone => {
      switch (p.state) {
        case 'done':
        case 'dryRun':
          return 'done';
        case 'running':
        case 'late':
        case 'stalled':
        case 'waiting':
          // `waiting` is a planned pass not started yet; the others are the running pass.
          if (p.state === 'waiting' && p.run === null) return ended ? 'dead' : 'idle';
          return marked ? 'dead' : running;
        case 'failed':
          return marked ? 'dead' : 'failed';
        case 'skipped':
          return 'dead';
        case 'notRun':
        case 'required':
          return 'idle';
      }
    })();
    return { pass: p.pass, by: p.by, tone };
  });
}

/** The *Passes* stat's sub-line: "2 done · load stalled · 7 waiting". */
export function passesLine(passes: readonly PassRowView[], liveness: LivenessView): string {
  const script = passes.filter((p) => p.by === 'script');
  if (script.length === 0) return RUN_WORDS.noPlan;
  const done = script.filter((p) => p.state === 'done' || p.state === 'dryRun').length;
  const parts = [RUN_WORDS.passesDone(done)];
  const now = script.find(
    (p) => p.run !== null && ['running', 'late', 'stalled', 'waiting', 'failed'].includes(p.state),
  );
  if (now !== undefined) {
    const word =
      now.state === 'failed'
        ? PASS_STATE_WORDS.failed
        : liveness.state === 'late' || liveness.state === 'stalled'
          ? PASS_STATE_WORDS[liveness.state]
          : liveness.state === 'waiting'
            ? STATE_WORDS.waiting.toLowerCase()
            : PASS_STATE_WORDS.running;
    parts.push(RUN_WORDS.passState(now.pass, word));
  }
  // As the board counts them: every pass not reached yet, the by-hand ones included.
  const waiting = passes.filter(
    (p) =>
      p.run === null && (p.state === 'waiting' || p.state === 'notRun' || p.state === 'required'),
  ).length;
  const skipped = script.filter((p) => p.state === 'skipped').length;
  if (waiting > 0) parts.push(RUN_WORDS.passesWaiting(waiting));
  if (skipped > 0) parts.push(RUN_WORDS.passesSkipped(skipped));
  return parts.join(' · ');
}

/** A pass row's state, as the table words and tones it. */
export function passState(
  p: PassRowView,
  liveness: LivenessView,
): { words: string; tone: 'fg' | 'warn' | 'bad' | 'dim' | 'quiet' } {
  if (
    p.run !== null &&
    (p.state === 'running' || p.state === 'late' || p.state === 'stalled' || p.state === 'waiting')
  ) {
    // The running pass: the campaign's liveness at the page's clock.
    if (liveness.state === 'stalled') return { words: PASS_STATE_WORDS.stalled, tone: 'bad' };
    if (liveness.state === 'late') return { words: PASS_STATE_WORDS.late, tone: 'warn' };
    if (liveness.state === 'waiting')
      return { words: STATE_WORDS.waiting.toLowerCase(), tone: 'warn' };
    return { words: PASS_STATE_WORDS.running, tone: 'fg' };
  }
  switch (p.state) {
    case 'failed':
      return { words: PASS_STATE_WORDS.failed, tone: 'bad' };
    case 'required':
      return { words: PASS_STATE_WORDS.required, tone: 'warn' };
    case 'done':
    case 'dryRun':
      return { words: PASS_STATE_WORDS[p.state], tone: 'quiet' };
    default:
      return { words: PASS_STATE_WORDS[p.state], tone: 'dim' };
  }
}

/** The log's drawing state: live while the run writes, failed once it failed, else finished. */
export function tailState(
  status: 'running' | 'succeeded' | 'failed',
  marked: boolean,
): 'live' | 'finished' | 'failed' {
  if (status === 'failed' || marked) return 'failed';
  return status === 'running' ? 'live' : 'finished';
}

/** The line the page draws at the tail's end while a run is quiet: never stored. */
export type QuietLine = { word: string; tone: 'warn' | 'bad'; text: string; fail: boolean };

export function quietLine(
  liveness: LivenessView,
  lastHeardAt: number | null,
  timeZone?: string,
): QuietLine | null {
  if (liveness.state !== 'late' && liveness.state !== 'stalled') return null;
  const since = lastHeardAt === null ? '' : clockSeconds(lastHeardAt, timeZone);
  const stalled = liveness.state === 'stalled';
  const text =
    liveness.expectedMs === null || liveness.expectedMs <= 0
      ? TAIL_WORDS.quietLineNoPace(since)
      : TAIL_WORDS.quietLine(
          since,
          everyWords(liveness.expectedMs),
          quietWords(liveness.quietMs),
          Math.floor(liveness.quietMs / liveness.expectedMs),
        );
  return {
    word: stalled ? TAIL_WORDS.stalled : TAIL_WORDS.late,
    tone: stalled ? 'bad' : 'warn',
    text,
    fail: stalled,
  };
}

/** The run a campaign's tail shows first: the running (or, when none runs, the last) pass, else the campaign's own row. */
export function defaultTailRun(
  view: Pick<CampaignView, 'current' | 'row' | 'passes'>,
): Id<'importRuns'> {
  const running = runningPass(view);
  if (running !== null) return running.runId;
  // Between passes the campaign's own lines say what it is doing; once ended, its last pass's.
  if (view.row.status === 'running') return view.row.id;
  return view.current?.runId ?? view.row.id;
}

/** The run *Mark failed* and *Wait* act on: the running pass, else (between passes) the campaign row. */
export function actionTarget(view: Pick<CampaignView, 'current' | 'row' | 'passes'>): {
  runId: Id<'importRuns'>;
  title: string;
} {
  const running = runningPass(view);
  return running !== null
    ? { runId: running.runId, title: running.pass }
    : { runId: view.row.id, title: view.row.title };
}
