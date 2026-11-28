/**
 * **A cut attempt's log** (D344, D348, B01-8b): where the cutter uploads it, how its lines are
 * stamped, and the one pure merge the imagery pump runs at settle — the cutter's own upload with
 * what Fly says about the Machine and the pump's own framing lines, into the lines kept under the
 * attempt in Convex (`runEvents.attemptId`).
 *
 * **The contract between the cutter and the pump** (real, not a placeholder):
 *
 * - The pump passes the cutter `CUT_LOG_KEY` ({@link cutLogKey}: `logs/cuts/<season>/<granule>/a<n>.log`)
 *   and `CUT_ATTEMPT`. Without the key the cutter keeps its log local and uploads nothing.
 * - Each line the cutter uploads is {@link formatCutLogLine}: the writer's clock in epoch
 *   milliseconds, one space, the text (`1764201600123 gdalwarp: 0...10...`). A line that doesn't
 *   start with a stamp is kept, stamped as the line before it ({@link parseCutterLog}).
 * - The `EXIT` trap's last line is `exit <code>`.
 *
 * **The merge** is PLACEHOLDER (B01-8b-2's S3 builds it, with its property tests): every line keeps
 * its own clock and origin; ordered by time, the cutter's first on a tie; Fly's app lines kept only
 * after the cutter's last line; Fly's own lines (runner, OOM, exit) always; the exit event one line;
 * the pump's lines framing it; capped at {@link CUT_LOG_MAX_LINES}, the first
 * {@link CUT_LOG_HEAD_LINES} and the last {@link CUT_LOG_TAIL_LINES} kept and one `warn` line saying
 * how many in the middle were not.
 */

/** Who wrote a line (the Convex package's `RUN_EVENT_ORIGINS`). */
export type CutLogOrigin = 'cutter' | 'fly' | 'pump';

/** A kept line's kind, as a cron run's (`CronReportLine['kind']`). */
export type CutLogKind = 'line' | 'warn' | 'fail' | 'stage';

/** One line as the merge returns it, ready for `runEvents`. */
export interface CutLogLine {
  origin: CutLogOrigin;
  kind: CutLogKind;
  /** The writer's clock: the cutter's stamp, Fly's timestamp, the pump's clock. */
  loggedAt: number;
  text: string;
}

/** A line of the cutter's upload, parsed. */
export interface CutterLogLine {
  loggedAt: number;
  text: string;
}

/**
 * A line of Fly's log for the Machine: `app` is the cutter's own stdout and stderr (which the upload
 * already holds, up to its last 20 seconds); `runner` is Fly's own word (the VM, an OOM kill, the
 * exit), which only Fly has.
 */
export interface FlyLogLine {
  loggedAt: number;
  text: string;
  source: 'app' | 'runner';
}

/** Fly's exit event for the Machine; any field Fly didn't send is `null`. */
export interface CutExit {
  exitCode: number | null;
  oomKilled: boolean | null;
  exitedAt: number | null;
}

/** A line the pump adds (*spawned on shared-cpu-4x · 2 GB*, *settled failed: attempts spent*). */
export interface PumpLogLine {
  loggedAt: number;
  text: string;
  kind?: CutLogKind;
}

export interface MergeCutLogInput {
  /** The cutter's upload, parsed; empty when there was none (an old image, a lost object). */
  cutter: readonly CutterLogLine[];
  /** Fly's lines for the Machine; empty when they weren't read (a landed cut) or couldn't be. */
  fly: readonly FlyLogLine[];
  exit: CutExit | null;
  pump: readonly PumpLogLine[];
}

export interface MergedCutLog {
  lines: CutLogLine[];
  /** How many lines in the middle the cap left out (counted on the one `warn` line). */
  dropped: number;
}

/** The most lines kept for one attempt: `runEvents`' `MAX_RUN_EVENTS`. */
export const CUT_LOG_MAX_LINES = 2_000;
/** Past the cap, the first lines kept. */
export const CUT_LOG_HEAD_LINES = 300;
/** Past the cap, the last lines kept (head + tail + the one `warn` line = the cap). */
export const CUT_LOG_TAIL_LINES = 1_699;

/** Where the cutter uploads attempt `attempt` (1-based) of `granuleId` in `season`. */
export function cutLogKey(season: string, granuleId: string, attempt: number): string {
  return `logs/cuts/${season}/${granuleId}/a${attempt}.log`;
}

/** One uploaded line: the stamp, a space, the text. */
export function formatCutLogLine(loggedAt: number, text: string): string {
  return `${Math.trunc(loggedAt)} ${text}`;
}

const STAMPED = /^(\d{12,16}) (.*)$/;

/**
 * The cutter's upload, line by line. A stamped line keeps its stamp; an unstamped one (a child's
 * line the tee couldn't split, a truncated write) is kept with the stamp before it, or `0` when
 * none came first; blank lines are dropped.
 */
export function parseCutterLog(text: string): CutterLogLine[] {
  const lines: CutterLogLine[] = [];
  let last = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const m = STAMPED.exec(raw);
    if (m !== null) {
      last = Number(m[1]);
      lines.push({ loggedAt: last, text: m[2] as string });
    } else {
      lines.push({ loggedAt: last, text: raw });
    }
  }
  return lines;
}

/**
 * PLACEHOLDER (B01-8b-2, S3): the merge described above. The seam returns the contract's shape and
 * keeps nothing, so nothing built on it can mistake it for the real merge.
 */
export function mergeCutLog(_input: MergeCutLogInput): MergedCutLog {
  return { lines: [], dropped: 0 };
}
