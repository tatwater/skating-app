/**
 * **Every word the run pages say** — the campaign page, the run page, the live tail and the
 * actions on a run — in one module for the founder's copy pass. Boards 6.2 and `live-v5` §1 gave
 * most of them; the rest were written for states no board draws and are named in the builder's
 * report. The list and the sidebar keep theirs in `machineryWords.ts`.
 *
 * Nothing here is about ice: a run is late, stalled or failed — never "safe", "fine" or "done
 * with" anything a skater reads. No decision numbers, section marks or phase tokens.
 */

import { plural } from '@/lib/ages';

/** A run's state, as its head badge and the passes table say it. */
export const STATE_WORDS = {
  running: 'Running',
  late: 'Late',
  stalled: 'Stalled',
  waiting: 'Waiting',
  notRecorded: 'No heartbeat recorded',
  succeeded: 'Succeeded',
  failed: 'Failed',
  markedFailed: 'Marked failed',
} as const;

/** A pass's state in the *Passes* table (lowercase, as the board's mono column writes them). */
export const PASS_STATE_WORDS = {
  done: 'done',
  running: 'running',
  late: 'late',
  stalled: 'stalled',
  /** Planned, not started yet (the board's *waiting*). */
  waiting: 'waiting',
  failed: 'failed',
  skipped: 'skipped',
  notRun: 'not run',
  required: 'required',
  dryRun: 'dry run',
} as const;

export const RUN_WORDS = {
  // ── The head ──────────────────────────────────────────────────────────────────────────────
  campaign: 'Campaign',
  singlePass: 'Single pass',
  campaignPass: 'Campaign pass',
  scopeNotRecorded: 'Scope not recorded',
  /** `full-canonical` → "full canonical". */
  scope: (pass: string) => pass.replace(/-/g, ' '),
  /** The states a scope named (`VT, NH`), when it isn't all five. */
  states: (states: readonly string[]) => states.join(', '),
  quiet: (words: string) => `${words} quiet`,
  waitingUntil: (clock: string) => `Waiting until ${clock}`,
  markedAt: (clock: string) => `Marked failed · ${clock}`,
  dryRun: 'Dry run',
  campaignLink: (title: string) => `Campaign ${title} →`,

  // ── The stats ─────────────────────────────────────────────────────────────────────────────
  passes: 'Passes',
  batches: 'Batches',
  batchesUnit: 'batches',
  batchesSoFar: 'batches so far',
  totalNotRecorded: 'Total not recorded yet',
  bodiesLoaded: 'Bodies loaded',
  bodiesUnit: 'bodies',
  elapsed: 'Elapsed',
  took: 'Took',
  started: (clock: string) => `Started ${clock}`,
  heartbeat: 'Heartbeat',
  ended: 'Ended',
  byHand: 'By hand',
  agoUnit: (unit: string) => `${unit} ago`,
  quietUnit: (unit: string) => `${unit} quiet`,
  /** The heartbeat's sub-line: the expected gap, until the campaign's events measure one. */
  reportsEvery: (minutes: string) => `Reports about every ${minutes}`,
  noPace: 'No pace is set for this kind, so it is never called late',
  noHeartbeat: 'This run never recorded a heartbeat',
  lastHeard: (clock: string) => `Last heard ${clock}`,
  failures: 'Failures',
  failuresUnit: 'stored',
  failuresOf: (total: number) => `Of ${total.toLocaleString('en-US')} recorded`,

  /** "2 done · load stalled · 7 waiting" */
  passesDone: (n: number) => `${n} done`,
  passState: (pass: string, state: string) => `${pass} ${state}`,
  passesWaiting: (n: number) => `${n} waiting`,
  passesSkipped: (n: number) => `${n} skipped`,
  noPlan: 'No plan recorded',

  // ── The sections ──────────────────────────────────────────────────────────────────────────
  passesSection: 'Passes',
  onYourMachine: 'On your machine · run-corpus.sh',
  pass: 'Pass',
  whatItDoes: 'What it does',
  state: 'State',
  inUp: 'In / up',
  failed: 'Failed',
  startedHead: 'Started',
  tookHead: 'Took',
  byHandHead: 'By hand, after the campaign',
  byHandAssist: 'Each its own command · any order · a dry run until --apply',
  skippedBecause: (why: string) => `Skipped: ${why}`,
  notRecordedCampaign: 'Rebuilt from its runs · its flags and its plan were not recorded',
  flags: 'Flags',

  liveTail: 'Live tail',
  log: 'Log',
  scrollUp: 'Scroll up for full log output',
  loadingOlder: 'Loading earlier lines',
  noLines: 'No log lines recorded for this run',
  logLoading: 'Loading the log',

  whatToCheck: 'What to check',
  checkTerminal: 'The terminal',
  checkTerminalBody:
    'Is the process alive? A sleeping laptop stops the flushes without ending the run.',
  checkLogFile: 'The log file',
  checkLogFileBody: 'Every line, even after the last flush:',
  checkConvex: 'Convex logs',
  checkConvexBody: 'Write-conflict retries show there.',
  logPath: (campaignId: string) => `.scratch/merge/run-${campaignId}.log`,
  logPathUnknown: 'scripts/etl/.scratch/merge/, for the run started with this campaign',

  outcomeSoFar: 'Outcome so far',
  outcome: 'Outcome',
  outcomeOf: (pass: string) => `Outcome · ${pass}`,
  planNotRecorded: 'plan not recorded',
  lastFlush: (clock: string) => `Last flush ${clock}`,
  failuresStored: (stored: number) => `${stored.toLocaleString('en-US')} stored`,
  failuresMore: (first: string, more: number) => (more > 0 ? `${first}, ${more} more` : first),
  failuresNone: 'None',
  noCounts: 'No counts recorded yet',

  path: 'Path',
  pathEnd: 'Extract → filter → transform → load',
  noPath: 'Not recorded',
  checksumOk: '✓',
  checksumBad: 'checksum failed',
  missing: 'missing',
  built: (date: string) => date,

  coverage: 'Coverage',
  coverageOf: (covered: number, eligible: number, unit: string) =>
    `${covered.toLocaleString('en-US')} of ${eligible.toLocaleString('en-US')} ${unit}`,
  unexplained: 'Unexplained · not covered and not accounted for by any reason above',
  tallies: 'Tallies',
  moreInGroup: (n: number) => `${n} more in this group`,
  failuresSection: 'Failures',
  failuresHidden: (hidden: number, kept: number) =>
    `${hidden.toLocaleString('en-US')} more weren't stored · the run keeps the first ${kept.toLocaleString('en-US')}`,
  notes: 'Notes',
  error: 'Error',
  notRecorded: 'Not recorded',
  production: 'Production',

  // ── The mark and the wait ─────────────────────────────────────────────────────────────────
  markedBy: 'Marked failed',
  loaderLater: (status: 'succeeded' | 'failed') =>
    status === 'succeeded'
      ? 'The loader later reported it succeeded'
      : 'The loader later reported it failed',
  loaderLaterError: (error: string) => `Its own error: ${error}`,
  // The server's rule (`machineryWrites.markRunFailed`, fork 2): a mark asks for the sync when the
  // run had already changed bodies.
  noReconcile:
    'Marking it failed asks for a weather-cell sync if it had already changed bodies; the weekly sync runs either way.',
  waitingBy: 'Waiting',
  clockSkew: (words: string, ahead: boolean) =>
    `Your machine's clock is ${words} ${ahead ? 'ahead' : 'behind'}`,
  noRun: 'Nothing is open',
} as const;

/** The tail's own words: the word each kind of line wears, and the lines the page draws itself. */
export const TAIL_WORDS = {
  kind: {
    start: 'start',
    stage: 'stage',
    flush: 'flush',
    beat: 'beat',
    warn: 'warn',
    fail: 'fail',
    close: 'close',
    mark: 'marked',
    wait: 'wait',
    stop: 'stop',
    cap: 'cap',
  } as Record<string, string>,
  /** The `cap` row: how many lines past the log's limit were not kept. */
  capped: (dropped: number) =>
    `${plural(dropped, 'more line', 'more lines')} past the log's limit weren't kept · the terminal and the log file have every line`,
  cappedUnknown:
    "Lines past the log's limit weren't kept · the terminal and the log file have every line",
  /** The page's own last line, while a run is quiet (never stored). */
  late: 'late',
  stalled: 'stalled',
  quietLine: (since: string, every: string, quiet: string, missed: number) =>
    `no flush since ${since} · one about every ${every} · ${quiet} is about ${missed} missed`,
  quietLineNoPace: (since: string) => `no flush since ${since}`,
} as const;

/** The actions on a run: the bar's buttons, their tooltips, the dialog, the receipts. */
export const ACTION_WORDS = {
  bar: 'Run actions',
  markFailed: 'Mark failed',
  markFailedWhat: 'If nothing is running: end this run as failed, saying why. You can undo it.',
  wait: 'Wait 30 minutes',
  waitWhat:
    'If it may still be working: hold the stalled alarm for 30 minutes. A flush clears it sooner.',
  stop: 'Stop',
  stopWhat: 'Ask the run to stop at its next flush, and the campaign before its next pass.',

  dialogTitle: (title: string) => `Mark ${title} failed?`,
  dialogBody:
    "Use this when nothing is running any more. The run ends as failed with your reason; if the loader's own close arrives later, it is kept beside the mark.",
  reasonLabel: 'Why · kept on the run and in the audit log',
  reasonPlaceholder: 'Laptop slept; no process.',
  confirm: 'Mark failed',

  marked: 'Marked failed',
  markedLine: "Nothing was scheduled. If the loader's own close comes, it's kept beside the mark.",
  waited: 'Waiting 30 minutes',
  waitedLine: (clock: string) => `The stalled alarm is held until ${clock}`,
  stopAsked: 'Asked to stop',
  stopAskedLine: 'It stops at its next flush',

  notMarked: (title: string) => `Not marked failed · ${title}`,
  notWaited: (title: string) => `Not waited on · ${title}`,
  notStopped: (title: string) => `Not asked to stop · ${title}`,
} as const;
