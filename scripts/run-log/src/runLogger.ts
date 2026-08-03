/**
 * The run logger every loader wraps its work in (N6c F2).
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
 */

import process from 'node:process';
import type { DeploymentTarget } from './deployment';
import type { ImportRunCoverage, ImportRunKind, RunCount, RunFailure, RunStage } from './types';

/**
 * How many itemized failures a loader forwards.
 *
 * Matches the server's `MAX_STORED_FAILURES`. Capping on *both* sides is not redundant: the server
 * cap protects the document, and this one protects the `convex run` argv — the CLI takes its args
 * as an inline JSON string against a ~1 MiB `ARG_MAX`, so a run that declined 40,000 features would
 * otherwise fail to report that it had.
 */
export const MAX_FORWARDED_FAILURES = 200;

/** How the logger reaches Convex. Injectable so the logic is testable without a deployment. */
export type ConvexCaller = <T>(functionName: string, args: unknown) => T;

export interface RunLoggerOptions {
  kind: ImportRunKind;
  label: string;
  campaignId?: string;
  target: DeploymentTarget;
  /** Stages already known before the run starts — the archived extract, the filter command. */
  stages?: RunStage[];
  notes?: string[];
  call: ConvexCaller;
  /** Defaults to `process.stderr.write`; injectable so tests can assert the warnings. */
  warn?: (message: string) => void;
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

  constructor(private readonly options: RunLoggerOptions) {}

  /** Open the row. Safe to skip calling — every other method degrades to a no-op if this failed. */
  start(): void {
    this.guard('start', () => {
      this.runId = this.options.call<string>('importRuns:start', {
        kind: this.options.kind,
        label: this.options.label,
        campaignId: this.options.campaignId,
        deployment: this.options.target.label,
        isProd: this.options.target.isProd,
        stages: this.options.stages ?? [],
        notes: this.options.notes,
      });
    });
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
  }

  /**
   * Record one itemized failure.
   *
   * Always counted; forwarded only while there is room under {@link MAX_FORWARDED_FAILURES}. The
   * count is what makes the truncation honest, so it is incremented unconditionally and first.
   */
  fail(failure: RunFailure): void {
    this.failuresTotal++;
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
    this.guard('progress', () => {
      this.options.call('importRuns:progress', { runId: this.runId, ...this.drain() });
    });
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
    this.close('failed', error instanceof Error ? error.message : String(error), notes);
  }

  private close(status: 'succeeded' | 'failed', error: string | undefined, notes?: string[]): void {
    if (this.runId === undefined || this.closed) return;
    this.closed = true;
    this.guard('finish', () => {
      this.options.call('importRuns:finish', {
        runId: this.runId,
        status,
        error,
        notes,
        ...this.drain(),
      });
    });
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
    return {
      counts: [...this.counts].map(([name, value]) => ({ name, value })),
      stages,
      failures,
      failuresTotal: this.failuresTotal,
      ...(coverage ? { coverage } : {}),
    };
  }

  /** Run `fn`, turning any throw into a stderr warning. See rule 1 in the file comment. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const warn = this.options.warn ?? ((m: string) => process.stderr.write(m));
      warn(`[run-log] ${what} failed (the import itself is unaffected): ${message}\n`);
    }
  }
}
