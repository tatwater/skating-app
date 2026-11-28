/**
 * **Every word the cron pieces draw** — the card, the strip and the runs drawer — kept here so the
 * founder reads them in one place and Weather and Health reuse them as they are. Relaxed and plain;
 * no decision numbers, no phase tokens. Machine time only, never money.
 *
 * Safety (D3): these words are about the machinery — whether a job ran, and what it did — never
 * about the ice.
 */

import { humanize } from '../corpus/runFormat';

/** A cron's state, as the card and the drawer's tabs set it (in caps where it stands alone). */
export const CRON_STATE_WORDS = {
  never: 'Not recorded yet',
  running: 'Running',
  killed: 'Cut off',
  failed: 'Failed',
  late: 'Late',
  stalled: 'Stalled',
  retried: 'Retried',
  ok: 'On time',
} as const;

/** A run's outcome, as its row writes it when the run carries no words of its own. */
export const RUN_OUTCOME_WORDS = {
  ok: 'Did its work',
  capped: 'Stopped at its limit · the next run picks up',
  refused: 'Turned down · tries again next time',
  failed: 'Failed',
  killed: 'Cut off before it finished',
} as const;

/** A tick's kind, as the legend, the hover plate and a screen reader name it. */
export const TICK_WORDS = {
  quiet: 'Nothing to do',
  worked: 'Did something',
  refused: 'Turned down',
  failed: 'Failed',
  killed: 'Cut off',
} as const;

export const CRON_WORDS = {
  runs: 'Runs',
  /** The drawer's title: "Imagery runs". */
  drawerTitle: (pipeline: string | null) => (pipeline === null ? 'Runs' : `${pipeline} runs`),
  last: (when: string) => `last ${when}`,
  next: (when: string) => `next ${when}`,
  /** A sparse cron's card: its quiet ticks are kept once an hour. */
  keptHourly: 'quiet checks kept hourly',
  startedBy: (name: string) => `Started by ${name}`,
  noRunsYet: 'No runs yet',
  noFailedRuns: 'No failed runs',
  failedOmitsKilled:
    'Runs that were cut off before they finished aren’t listed here. They’re under All.',
  olderOnScroll: 'Older runs load as you scroll',
  loadingOlder: 'Loading older runs',
  allLoaded: 'That’s every run kept',
  filters: { all: 'All', worked: 'Did something', failed: 'Failed' },
  filterLabel: 'Which runs',
  columns: { run: 'Run', took: 'Took', outcome: 'Outcome' },
  log: 'Log',
  hideLog: 'Hide log',
  logLabel: (when: string) => `Log of the run at ${when}`,
  logLoading: 'Loading the log',
  noLines: 'This run didn’t keep any lines.',
  scrollUp: 'Scroll up for older lines',
  pressedBy: (name: string) => `Run now · ${name}`,
  pressed: 'Run now',
  /** The folded quiet line: "12 quiet checks · 13:54–14:00". */
  quietChecks: (n: number) =>
    n === 1 ? '1 quiet check' : `${n.toLocaleString('en-US')} quiet checks`,
  /** A sparse cron's folded line: its quiet ticks are one an hour, so it counts hours. */
  quietHours: (n: number) =>
    n === 1 ? '1 quiet hour' : `${n.toLocaleString('en-US')} quiet hours`,
  stripLast: (hours: number) => `The last ${hours} hours`,
  stripDays: (days: number) => `The last ${days} days`,
  sinceTheStart: 'Since the start',
  now: 'Now',
  stripLabel: (label: string) => `Ticks · ${label.toLowerCase()}`,
  stripEmpty: 'Nothing recorded in this range yet',
  stripTruncated: 'Older ticks in this range aren’t drawn',
  sparseStrip: 'Quiet checks are kept once an hour',
  took: (words: string) => `Took ${words}`,
  /** The strip's summary for a screen reader. */
  stripSummary: (parts: string[]) => (parts.length === 0 ? 'No ticks' : parts.join(', ')),
  tickCount: (n: number, word: string) => `${n.toLocaleString('en-US')} ${word.toLowerCase()}`,
  readFailed: {
    strip: 'The ticks didn’t load.',
    runs: 'The runs didn’t load.',
    log: 'That log didn’t load.',
    jobs: 'The crons didn’t load.',
  },
  tryAgain: 'Try again',
} as const;

/** A count under its name, lower case: "6 queued", "1 refused" ("6 new" when a page names it). */
export function countWords(name: string, n: number): string {
  return `${n.toLocaleString('en-US')} ${humanize(name).toLowerCase()}`;
}

/**
 * A run's counts as one line, its first few in the order the job reported them: "6 queued · 10
 * found". Zero counts are left out; `null` when nothing is left.
 */
export function countsLine(counts: Record<string, number> | null, max = 3): string | null {
  if (counts === null) return null;
  const parts = Object.entries(counts)
    .filter(([, n]) => Number.isFinite(n) && n !== 0)
    .slice(0, max)
    .map(([k, n]) => countWords(k, n));
  return parts.length === 0 ? null : parts.join(' · ');
}
