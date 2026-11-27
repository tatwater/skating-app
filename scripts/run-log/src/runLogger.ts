/**
 * The run logger every loader wraps its work in (A06c §6.2).
 *
 * Two rules shape the whole class:
 *
 * 1. **Bookkeeping never breaks the thing it books.** Every call into Convex is swallowed and
 *    reported to stderr. An import that dies because its run-history row could not be written would
 *    be a strictly worse world than the printed summaries this replaces — the observability is the
 *    junior partner here, always.
 * 2. **A crashed loader still leaves a record.** The row is opened before the first batch, so the
 *    failure mode a printed summary can never capture (killed process, blown memory, unplugged
 *    laptop) shows up in the admin list as a run stuck in `running`, naming what it was doing.
 *
 * ## The live log (D341, B01-8a)
 *
 * The logger also keeps the run's log, line by line, for Machinery's live tail: a line for each call
 * it already receives (start, a new stage, the failures and counts at each flush, a beat's label, the
 * close), sent to `runEvents:append` after each `progress` and after the `finish`. No loader writes a
 * line itself. `beat()` is how a pass that never flushed stays visibly alive: cheap enough for a hot
 * loop (a clock read), it reaches Convex only when `beatMs` has passed since the logger last did.
 *
 * `append`'s answer carries the console back to the laptop: a run marked failed carries on (its own
 * close is kept beside the mark), and a run asked to stop closes itself as failed and exits.
 *
 * **A deployment that predates the live log loses only the lines, never the counts.** Its `start`
 * refuses the campaign's keys, so the start is retried once without them; its `append` doesn't
 * exist, so the first refusal turns the lines off for the run with one warning. `progress` and
 * `finish` are untouched either way.
 */

import type { DeploymentTarget } from './deployment';
import type {
  ImportRunCoverage,
  ImportRunKind,
  ImportRunScope,
  RunCount,
  RunFailure,
  RunStage,
} from './types';

import process from 'node:process';

/**
 * How many itemized failures a loader forwards.
 *
 * Matches the server's `MAX_STORED_FAILURES`. Capping on *both* sides is not redundant: the server
 * cap protects the document, and this one protects the `convex run` argv — the CLI takes its args
 * as an inline JSON string against a ~1 MiB `ARG_MAX`, so a run that declined 40,000 features would
 * otherwise fail to report that it had.
 */
export const MAX_FORWARDED_FAILURES = 200;

/** A dry run's last note, start to finish: the row says it wrote nothing, whatever else it says. */
export const DRY_RUN_NOTE = 'dry run — nothing written';

/** The longest the logger lets pass without reaching Convex while `beat()` is being called. */
export const DEFAULT_BEAT_MS = 60_000;

/** Lines one `runEvents:append` carries — the server's `MAX_RUN_EVENT_APPEND`, which refuses more. */
export const MAX_EVENTS_PER_APPEND = 200;

/** A line's length — the server's `MAX_RUN_EVENT_TEXT`; trimmed here too, to keep the argv small. */
export const MAX_EVENT_TEXT = 500;

/** When an append would carry too many lines: the first this many, then a note, then the last. */
const KEEP_HEAD = 150;

/** The environment `run-corpus.sh` sets for each pass: its name, and the campaign row's id. */
export const PASS_ENV = 'RUN_CORPUS_PASS';
export const PARENT_ENV = 'RUN_CORPUS_PARENT';

/** The process exit status after a stop request — what a shell reports for an interrupt. */
export const STOPPED_EXIT_CODE = 130;

/** The error a run asked to stop closes with. */
export const STOPPED_ERROR = 'Stopped on request';

/** The notes with the dry-run label last, once — for a dry run; as given otherwise. */
const labeled = (dryRun: boolean, notes: string[] | undefined): string[] | undefined =>
  dryRun ? [...(notes ?? []).filter((n) => n !== DRY_RUN_NOTE), DRY_RUN_NOTE] : notes;

/** How the logger reaches Convex. Injectable so the logic is testable without a deployment. */
export type ConvexCaller = <T>(functionName: string, args: unknown) => T;

/** The kinds of line a logger may send (`RUN_EVENT_LOGGER_KINDS`); the rest are the console's. */
export type RunEventKind = 'start' | 'stage' | 'flush' | 'beat' | 'warn' | 'fail' | 'close';

/** One line of the run's log, as `runEvents:append` takes it. */
export interface RunEventLine {
  kind: RunEventKind;
  text: string;
  /** This machine's clock when the line was seen. */
  loggedAt: number;
}

/** What `runEvents:append` answers: the console's directives, and what it kept. */
export interface AppendResult {
  /** The run, or its campaign, was asked to stop. */
  stop: boolean;
  /** The run was marked failed in the console. */
  markedFailed: boolean;
  stored: number;
  dropped: number;
}

/** The answer, read defensively: anything that isn't an object says nothing. */
export function readDirectives(result: unknown): { stop: boolean; markedFailed: boolean } {
  if (typeof result !== 'object' || result === null) return { stop: false, markedFailed: false };
  const r = result as Partial<AppendResult>;
  return { stop: r.stop === true, markedFailed: r.markedFailed === true };
}

/** A line trimmed to what the server keeps, so the argv never carries what it would cut. */
export function eventText(text: string): string {
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT - 1)}…` : text;
}

/**
 * At most {@link MAX_EVENTS_PER_APPEND} lines: past it, the first lines, one `warn` line saying how
 * many were left out, and the last — a loop gone wrong keeps its start and its end.
 */
export function boundEvents(lines: readonly RunEventLine[]): RunEventLine[] {
  if (lines.length <= MAX_EVENTS_PER_APPEND) return [...lines];
  const tail = MAX_EVENTS_PER_APPEND - KEEP_HEAD - 1;
  const left = lines.length - KEEP_HEAD - tail;
  const at = lines[KEEP_HEAD]?.loggedAt ?? 0;
  return [
    ...lines.slice(0, KEEP_HEAD),
    {
      kind: 'warn',
      text: `${left.toLocaleString('en-US')} lines left out here — too many for one report`,
      loggedAt: at,
    },
    ...lines.slice(-tail),
  ];
}

/** `full canonical, 5 states`, `seed`, `derived, VT, partial` — a scope as the start line says it. */
export function scopeWords(scope: ImportRunScope): string {
  const parts = [scope.pass.replace(/-/g, ' ')];
  const states = scope.states ?? [];
  if (states.length === 1) parts.push(states[0] as string);
  else if (states.length > 1) parts.push(`${states.length} states`);
  if (!scope.complete) parts.push('partial');
  return parts.join(', ');
}

/**
 * `inserted=1200, updated=40` — the counts in the order the loader first set them, as many as fit
 * in one line, then how many more there were.
 */
export function countsLine(counts: readonly RunCount[]): string {
  const pairs = counts.map((c) => `${c.name}=${c.value}`);
  let text = '';
  for (const [i, pair] of pairs.entries()) {
    const next = text === '' ? pair : `${text}, ${pair}`;
    const rest = pairs.length - i - 1;
    // Room is kept for the "… and N more" that a line cut after this pair would need.
    const reserve = rest > 0 ? ` … and ${rest} more`.length : 0;
    if (next.length + reserve > MAX_EVENT_TEXT) {
      return text === '' ? eventText(next) : `${text} … and ${rest + 1} more`;
    }
    text = next;
  }
  return text;
}

/** `3 new failures · e.g. nhd/3290011 · self-intersects after simplify`. */
export function failuresLine(count: number, first: RunFailure): string {
  const example = [first.key, first.reason].filter((s) => s !== undefined && s !== '').join(' · ');
  return `${count.toLocaleString('en-US')} new failure${count === 1 ? '' : 's'} · e.g. ${example}`;
}

export interface RunLoggerOptions {
  kind: ImportRunKind;
  label: string;
  campaignId?: string;
  target: DeploymentTarget;
  /** Stages already known before the run starts — the archived extract, the filter command. */
  stages?: RunStage[];
  notes?: string[];
  /**
   * What the run set out to cover (D218): the pass, its states, and whether that is all of it.
   * Stated at `start` and never after — a run's scope is its intent, not its outcome.
   */
  scope?: ImportRunScope;
  /**
   * The loader writes nothing (no `--apply`): the row's notes end with {@link DRY_RUN_NOTE} from
   * its start through its close — a close's own notes replace the start's on the server, so the
   * label is put back after them — and it closes as not applied, so it invalidates nothing.
   */
  dryRun?: boolean;
  call: ConvexCaller;
  /** Defaults to `process.stderr.write`; injectable so tests can assert the warnings. */
  warn?: (message: string) => void;
  /** The longest the logger lets pass without reaching Convex while `beat()` is being called. */
  beatMs?: number;
  /** What a stop directive does once the row is closed. Default: `process.exit(130)`. */
  onStop?: () => never;
  /** Where `RUN_CORPUS_PASS` and `RUN_CORPUS_PARENT` are read. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** This machine's clock. Default: `Date.now`. */
  now?: () => number;
}

export class RunLogger {
  private runId: string | undefined;
  private readonly counts = new Map<string, number>();
  private pendingStages: RunStage[] = [];
  private pendingFailures: RunFailure[] = [];
  private pendingCoverage: ImportRunCoverage | undefined;
  private forwarded = 0;
  private failuresTotal = 0;
  private closed = false;

  // The live log.
  private lines: RunEventLine[] = [];
  private eventsOn = true;
  private readonly stagesSeen = new Set<string>();
  private readonly countsSent = new Map<string, number>();
  private failuresReported = 0;
  private firstUnreported: RunFailure | undefined;
  private beatLabel: string | undefined;
  private lastReached = 0;
  private markSeen = false;
  private stopping = false;

  private readonly pass: string | undefined;
  private readonly parent: string | undefined;
  private readonly beatMs: number;
  private readonly now: () => number;

  constructor(private readonly options: RunLoggerOptions) {
    const env = options.env ?? process.env;
    // Empty is absent: the script exports an empty parent when the campaign's row couldn't open.
    this.pass = env[PASS_ENV] || undefined;
    this.parent = env[PARENT_ENV] || undefined;
    this.beatMs = options.beatMs ?? DEFAULT_BEAT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Open the row. Safe to skip calling — every other method degrades to a no-op if this failed. */
  start(): void {
    const base = {
      kind: this.options.kind,
      label: this.options.label,
      campaignId: this.options.campaignId,
      deployment: this.options.target.label,
      isProd: this.options.target.isProd,
      stages: this.options.stages ?? [],
      notes: labeled(this.options.dryRun === true, this.options.notes),
      // Omitted, not `undefined`: the argv is JSON, and an older deployment's exact validator
      // refuses a key it doesn't know only when the key is there.
      ...(this.options.scope !== undefined && { scope: this.options.scope }),
    };
    const extras = {
      ...(this.parent !== undefined && { parentRunId: this.parent }),
      ...(this.pass !== undefined && { campaignPass: this.pass }),
    };
    this.guard('start', () => {
      this.lastReached = this.now();
      if (Object.keys(extras).length === 0) {
        this.runId = this.options.call<string>('importRuns:start', base);
        return;
      }
      try {
        this.runId = this.options.call<string>('importRuns:start', { ...base, ...extras });
      } catch (err) {
        // A deployment from before the campaign's keys (or a parent it can't read): the row as it
        // would have been written without them — it lists on its own instead of under its campaign.
        this.say(
          `[run-log] start refused the campaign's keys (${messageOf(err)}); opening the run without them\n`,
        );
        this.runId = this.options.call<string>('importRuns:start', base);
      }
    });
    if (this.runId === undefined) return;
    this.push('start', this.startLine());
    this.sendLines();
  }

  /** Set a named tally to its current running total (replace, never add — see `importRuns.ts`). */
  count(name: string, value: number): void {
    this.counts.set(name, value);
  }

  /** Add or replace a stage by name. Re-sending a stage is how its counts firm up. */
  stage(stage: RunStage): void {
    const at = this.pendingStages.findIndex((s) => s.name === stage.name);
    if (at === -1) this.pendingStages.push(stage);
    else this.pendingStages[at] = stage;
    // One line per stage, the first time it is named: a re-send firms up counts, it is not news.
    if (!this.stagesSeen.has(stage.name)) {
      this.stagesSeen.add(stage.name);
      this.push('stage', stage.detail ? `${stage.name} · ${stage.detail}` : stage.name);
    }
  }

  /**
   * Record one itemized failure.
   *
   * Always counted; forwarded only while there is room under {@link MAX_FORWARDED_FAILURES}. The
   * count is what makes the truncation honest, so it is incremented unconditionally and first.
   */
  fail(failure: RunFailure): void {
    this.failuresTotal++;
    this.firstUnreported ??= failure;
    if (this.forwarded + this.pendingFailures.length < MAX_FORWARDED_FAILURES) {
      this.pendingFailures.push(failure);
    }
  }

  /**
   * State this run's coverage: the denominator, what it stamped, and where the rest went.
   *
   * Call it once, at the end, with final numbers — it replaces wholesale rather than merging,
   * because coverage is one coherent statement and a half-updated denominator is worse than a
   * stale one.
   */
  coverage(coverage: ImportRunCoverage): void {
    this.pendingCoverage = coverage;
  }

  /** How many failures have been recorded — including the ones past the forwarding cap. */
  get totalFailures(): number {
    return this.failuresTotal;
  }

  /** Push everything buffered so far. Called periodically so a long run is visible while it runs. */
  flush(): void {
    if (this.runId === undefined || this.closed) return;
    this.lastReached = this.now();
    this.guard('progress', () => {
      this.options.call('importRuns:progress', { runId: this.runId, ...this.drain() });
    });
    if (this.lines.length === 0) this.push('flush', 'No new counts since the last report');
    this.sendLines();
  }

  /**
   * **A heartbeat for a pass that never flushes** — cheap enough for a hot loop: it reads the clock,
   * and reaches Convex (a flush) only once `beatMs` has passed since the logger last did. `label`
   * says where the pass is ("matching · 12,000 of 40,000 groups"); the latest one rides the flush
   * as a `beat` line.
   */
  beat(label?: string): void {
    if (this.runId === undefined || this.closed) return;
    if (label !== undefined) this.beatLabel = label;
    if (this.now() - this.lastReached < this.beatMs) return;
    this.flush();
  }

  /** Close the run as succeeded. */
  succeed(notes?: string[]): void {
    this.close('succeeded', undefined, notes);
  }

  /**
   * Close the run as failed, recording the error.
   *
   * The loader still rethrows — this marks the row, it does not swallow the failure. A run that
   * ended badly and says `succeeded` is the one outcome worse than no row at all.
   */
  failed(error: unknown, notes?: string[]): void {
    this.close('failed', messageOf(error), notes);
  }

  private close(status: 'succeeded' | 'failed', error: string | undefined, notes?: string[]): void {
    if (this.runId === undefined || this.closed) return;
    this.closed = true;
    this.lastReached = this.now();
    this.guard('finish', () => {
      const dryRun = this.options.dryRun === true;
      this.options.call('importRuns:finish', {
        runId: this.runId,
        status,
        error,
        // Absent keeps the start's notes, which already carry the label.
        notes: notes === undefined ? undefined : labeled(dryRun, notes),
        ...(dryRun && { applied: false }),
        ...this.drain(),
      });
    });
    this.push(
      'close',
      status === 'succeeded' ? 'Succeeded' : `Failed: ${error ?? 'no reason given'}`,
    );
    this.sendLines();
  }

  /** Take the buffered delta, leaving the buffers empty so a re-flush can't double-send failures. */
  private drain(): {
    counts: RunCount[];
    stages: RunStage[];
    failures: RunFailure[];
    failuresTotal: number;
    coverage?: ImportRunCoverage;
  } {
    const failures = this.pendingFailures;
    this.forwarded += failures.length;
    this.pendingFailures = [];
    const stages = this.pendingStages;
    this.pendingStages = [];
    const coverage = this.pendingCoverage;
    this.pendingCoverage = undefined;
    const counts = [...this.counts].map(([name, value]) => ({ name, value }));
    this.noteProgress(counts);
    return {
      counts,
      stages,
      failures,
      failuresTotal: this.failuresTotal,
      ...(coverage ? { coverage } : {}),
    };
  }

  /** The lines a report adds: the failures since the last, the counts that changed, the beat. */
  private noteProgress(counts: readonly RunCount[]): void {
    const newFailures = this.failuresTotal - this.failuresReported;
    if (newFailures > 0 && this.firstUnreported !== undefined) {
      this.push('fail', failuresLine(newFailures, this.firstUnreported));
    }
    this.failuresReported = this.failuresTotal;
    this.firstUnreported = undefined;
    const changed = counts.filter((c) => this.countsSent.get(c.name) !== c.value);
    for (const c of changed) this.countsSent.set(c.name, c.value);
    if (changed.length > 0) this.push('flush', countsLine(changed));
    if (this.beatLabel !== undefined) {
      this.push('beat', this.beatLabel);
      this.beatLabel = undefined;
    }
  }

  private startLine(): string {
    const parts = [`Run started · ${this.options.label}`];
    if (this.options.scope !== undefined) parts.push(scopeWords(this.options.scope));
    parts.push(this.options.target.label);
    if (this.options.dryRun === true) parts.push('dry run');
    return parts.join(' · ');
  }

  private push(kind: RunEventKind, text: string): void {
    if (!this.eventsOn) return;
    this.lines.push({ kind, text: eventText(text), loggedAt: this.now() });
  }

  /** Send the buffered lines and act on what the console answers. Never throws. */
  private sendLines(): void {
    if (!this.eventsOn || this.runId === undefined || this.lines.length === 0) return;
    const events = boundEvents(this.lines);
    this.lines = [];
    let answer: unknown;
    try {
      answer = this.options.call('runEvents:append', { runId: this.runId, events });
    } catch (err) {
      const message = messageOf(err);
      if (/could not find function/i.test(message)) {
        // The deployment predates the live log: the lines stop, the counts carry on.
        this.eventsOn = false;
        this.say(
          '[run-log] this deployment keeps no run log yet, so this run sends no log lines (its counts are still recorded)\n',
        );
      } else {
        this.say(`[run-log] log lines failed (the import itself is unaffected): ${message}\n`);
      }
      return;
    }
    this.obey(readDirectives(answer));
  }

  private obey(directives: { stop: boolean; markedFailed: boolean }): void {
    if (directives.markedFailed && !this.markSeen) {
      this.markSeen = true;
      this.say(
        '[run-log] This run was marked failed in the console; carrying on, and its own close will be kept beside the mark.\n',
      );
    }
    if (!directives.stop || this.stopping || this.closed) return;
    this.stopping = true;
    this.say('[run-log] This run was asked to stop in the console; closing it and exiting.\n');
    this.push('warn', 'Asked to stop in the console; stopping here');
    this.close('failed', STOPPED_ERROR);
    (this.options.onStop ?? (() => process.exit(STOPPED_EXIT_CODE)))();
  }

  private say(message: string): void {
    const warn = this.options.warn ?? ((m: string) => process.stderr.write(m));
    warn(message);
  }

  /** Run `fn`, turning any throw into a stderr warning. See rule 1 in the file comment. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.say(`[run-log] ${what} failed (the import itself is unaffected): ${messageOf(err)}\n`);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
