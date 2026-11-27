import { shortAge } from '@/lib/ages';

import { dayMonth } from '../../shell/consoleTime';
import { isRebuilt, type RunRowView } from '../machineryTypes';
import {
  bodiesLoaded,
  headlineWords,
  KIND_WORDS,
  NOT_RECORDED,
  passesWords,
  REBUILT,
  STATE_WORDS,
  scopeWords,
  stoppedAt,
} from '../words/machineryWords';

/**
 * **A run row as the list draws it** (board 6.2's middle column) — pure, so every word and tone is
 * tested without a page: the state chip and the kind chip over the title, the sub-line, the age.
 *
 * - **The state chip** reads the server's liveness first (a running row: *stalled* red, *late* and
 *   *waiting* amber, *running* lit, *no heartbeat* amber for a running row from before heartbeats),
 *   then the outcome (*failed* red; *dry run*, *applied* for a by-hand pass that wrote (the
 *   server's `applied`), else
 *   *succeeded*, all quiet).
 * - **A rebuilt campaign** (`isRebuilt`) never reads live: its record was put together from its
 *   runs after the fact, so a `running` on it is a fact nobody recorded, and the chip says so.
 * - **The sub-line** says what the row's facts say, and *Not recorded* where a fact is missing —
 *   never a zero or a blank read as one.
 * - **The age**: a live run's quiet ("41 min"); else when it ended — the clock today, the day and
 *   month before.
 */

export type ChipTone = 'bad' | 'warn' | 'lit' | 'ok' | 'default' | 'dim';
export type RunChip = { label: string; tone: ChipTone };

export interface RunRowModel {
  id: string;
  title: string;
  state: RunChip;
  kind: RunChip;
  sub: string;
  age: string;
  /** The row's live state, for its age's tone and a story's check. */
  live: 'stalled' | 'late' | 'waiting' | 'running' | 'notRecorded' | null;
  rebuilt: boolean;
}

/** The row's live state, or `null` for a finished one (and every rebuilt campaign). */
export function liveOf(row: RunRowView): RunRowModel['live'] {
  if (isRebuilt(row) || row.status !== 'running' || row.marked) return null;
  const state = row.liveness.state;
  return state === 'finished' ? null : state;
}

/** The state chip. */
export function stateChip(row: RunRowView): RunChip {
  const live = liveOf(row);
  switch (live) {
    case 'stalled':
      return { label: STATE_WORDS.stalled, tone: 'bad' };
    case 'late':
      return { label: STATE_WORDS.late, tone: 'warn' };
    case 'waiting':
      return { label: STATE_WORDS.waiting, tone: 'warn' };
    case 'notRecorded':
      return { label: STATE_WORDS.notRecorded, tone: 'warn' };
    case 'running':
      return { label: STATE_WORDS.running, tone: 'lit' };
    case null:
      break;
  }
  if (row.status === 'failed' || row.marked) return { label: STATE_WORDS.failed, tone: 'bad' };
  if (row.status === 'running') return { label: STATE_WORDS.unknown, tone: 'dim' };
  if (row.dryRun) return { label: STATE_WORDS.dryRun, tone: 'ok' };
  if (row.applied === true) return { label: STATE_WORDS.applied, tone: 'ok' };
  return { label: STATE_WORDS.succeeded, tone: 'ok' };
}

/** What the running pass is doing, as the sub-line says it ("load stalled"). */
function currentWords(current: string, live: RunRowModel['live']): string {
  switch (live) {
    case 'stalled':
    case 'late':
    case 'waiting':
    case 'running':
      return `${current} ${STATE_WORDS[live]}`;
    case 'notRecorded':
      return `${current} · ${STATE_WORDS.notRecorded}`;
    default:
      return current;
  }
}

/** The sub-line: the scope, then the facts the row carries, *Not recorded* for each it lacks. */
export function subLine(row: RunRowView): string {
  const parts: string[] = [];
  const rebuilt = isRebuilt(row);
  if (rebuilt) parts.push(REBUILT);
  else if (row.scope !== null) parts.push(scopeWords(row.scope));
  const { line } = row;
  if (line.kind === 'campaign') {
    const live = liveOf(row);
    parts.push(passesWords(line.passesDone, line.passesPlanned));
    if (line.current !== null && live !== null) parts.push(currentWords(line.current, live));
    else if (line.stoppedAt !== null) parts.push(stoppedAt(line.stoppedAt));
    // A campaign still at work hasn't loaded its bodies yet; a finished one that says nothing of them
    // didn't record it.
    if (line.bodiesLoaded !== null) parts.push(bodiesLoaded(line.bodiesLoaded));
    else if (live === null) parts.push(NOT_RECORDED);
  } else {
    parts.push(
      line.headline === null
        ? NOT_RECORDED
        : headlineWords(line.headline.name, line.headline.value),
    );
  }
  return parts.join(' · ');
}

const DAY = 86_400_000;

/** The clock in `timeZone` ("14:20"). */
function clock(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone !== undefined && { timeZone }),
  }).format(at);
}

/** The calendar date `at` falls on in `timeZone`. */
const dateKey = (at: number, timeZone?: string) =>
  new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone !== undefined && { timeZone }),
  }).format(at);

/** The row's age: a live run's quiet, else when it ended (the clock today, the date before). */
export function ageOf(row: RunRowView, now: number, timeZone?: string): string {
  // A live run's age is its quiet: how long since it last reported.
  if (liveOf(row) !== null && 'quietMs' in row.liveness) return shortAge(row.liveness.quietMs);
  const at = row.finishedAt ?? row.startedAt;
  if (now - at >= 0 && now - at < DAY && dateKey(at, timeZone) === dateKey(now, timeZone)) {
    return now - at < 3_600_000 ? shortAge(now - at) : clock(at, timeZone);
  }
  return dayMonth(at, timeZone);
}

export function rowModel(row: RunRowView, now: number, timeZone?: string): RunRowModel {
  return {
    id: row.id,
    title: row.title,
    state: stateChip(row),
    kind: { label: KIND_WORDS[row.kind], tone: 'default' },
    sub: subLine(row),
    age: ageOf(row, now, timeZone),
    live: liveOf(row),
    rebuilt: isRebuilt(row),
  };
}

// ── Month dividers ──────────────────────────────────────────────────────────────────────────────

export type RunListEntry =
  | { type: 'month'; key: string; label: string }
  | { type: 'row'; row: RunRowModel; index: number };

/** "October", or "July 2025" outside the year `now` is in — the month `at` starts in `timeZone`. */
export function monthLabel(at: number, now: number, timeZone?: string): string {
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { ...opts, ...(timeZone !== undefined && { timeZone }) });
  const year = fmt({ year: 'numeric' });
  const month = fmt({ month: 'long' }).format(at);
  return year.format(at) === year.format(now) ? month : `${month} ${year.format(at)}`;
}

/** The rows in the server's order, a divider before each new month a row starts in. */
export function withMonths(
  rows: readonly RunRowView[],
  now: number,
  timeZone?: string,
): RunListEntry[] {
  const out: RunListEntry[] = [];
  let last: string | null = null;
  rows.forEach((row, index) => {
    const key = dateKey(row.startedAt, timeZone).slice(0, 7);
    if (key !== last) {
      last = key;
      out.push({ type: 'month', key, label: monthLabel(row.startedAt, now, timeZone) });
    }
    out.push({ type: 'row', row: rowModel(row, now, timeZone), index });
  });
  return out;
}
