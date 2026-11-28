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
 * **The merge** ({@link mergeCutLog}): every line keeps its own clock and origin; ordered by time, the
 * cutter's first on a tie; Fly's app lines kept only after the cutter's last line; Fly's own lines
 * (runner, OOM, exit) always; the exit event one line; the pump's lines framing it; capped at
 * {@link CUT_LOG_MAX_LINES}, the first {@link CUT_LOG_HEAD_LINES} and the last
 * {@link CUT_LOG_TAIL_LINES} kept and one `warn` line saying how many in the middle were not.
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

/** A kept line's text, in characters (a cron run's line cap, `CRON_REPORT_LINE_MAX`). */
export const CUT_LOG_LINE_MAX = 500;

/** `text` cut to {@link CUT_LOG_LINE_MAX}, never through a surrogate pair. */
function trimLine(text: string): string {
  if (text.length <= CUT_LOG_LINE_MAX) return text;
  const cut = text.slice(0, CUT_LOG_LINE_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The `EXIT` trap's last line, `exit <code>`. */
const EXIT_LINE = /^exit (-?\d+)\b/;

/** A Fly runner line that names a kill: the one place a whole-VM out-of-memory kill is said. */
const KILL_WORDS = /out of memory|oom|killed/i;

/** The exit event as one line: `exit 137 · out of memory`; `null` when Fly sent nothing at all. */
export function exitLineText(exit: CutExit): string | null {
  if (exit.exitCode === null && exit.oomKilled === null && exit.exitedAt === null) return null;
  const code = exit.exitCode === null ? 'exit (no code)' : `exit ${exit.exitCode}`;
  return exit.oomKilled === true ? `${code} · out of memory` : code;
}

/** Which origin goes first among lines stamped the same millisecond: the cutter's, then Fly's. */
const ORIGIN_RANK: Record<CutLogOrigin, number> = { cutter: 0, fly: 1, pump: 2 };

/**
 * **The merge** (D348): the cutter's upload, what Fly said, and the pump's framing lines, as the one
 * log kept under the attempt.
 *
 * - Every line keeps its own clock and its origin; the lines are ordered by time, the cutter's first
 *   on a tie, then Fly's, then the pump's (each source keeps its own order within a millisecond).
 * - Fly's `app` lines are the cutter's own output, which the upload already holds up to its last line:
 *   one is kept only when it is later than the cutter's last line (the seconds the upload missed), so
 *   nothing is doubled. With no upload, every app line is kept. Fly's `runner` lines are always kept.
 * - The exit event is one Fly line (*exit 137 · out of memory*), stamped `exitedAt` (or, without it,
 *   the latest line's time); a non-zero code or an OOM kill makes it a `fail` line.
 * - Capped at {@link CUT_LOG_MAX_LINES}: past it, the first {@link CUT_LOG_HEAD_LINES} and the last
 *   {@link CUT_LOG_TAIL_LINES} are kept, with one pump `warn` line after the head saying how many in
 *   the middle were not. **The exit line and the cutter's last line are always kept**: one that falls
 *   in the middle is kept in its place, and the tail gives up a line for it, so a killed cut always
 *   keeps its end and the cap still holds.
 * - Every text is trimmed to {@link CUT_LOG_LINE_MAX}.
 */
export function mergeCutLog(input: MergeCutLogInput): MergedCutLog {
  type Pending = CutLogLine & { rank: number; order: number; pinned: boolean };
  const all: Pending[] = [];
  let order = 0;
  const push = (line: CutLogLine, pinned = false) =>
    all.push({
      ...line,
      text: trimLine(line.text),
      rank: ORIGIN_RANK[line.origin],
      order: order++,
      pinned,
    });

  const cutterLast = input.cutter.length > 0 ? input.cutter.length - 1 : -1;
  const cutterEnd = input.cutter.reduce(
    (m, l) => Math.max(m, l.loggedAt),
    Number.NEGATIVE_INFINITY,
  );
  input.cutter.forEach((l, i) => {
    const exit = EXIT_LINE.exec(l.text);
    const kind: CutLogKind = exit && Number(exit[1]) !== 0 ? 'fail' : 'line';
    push({ origin: 'cutter', kind, loggedAt: l.loggedAt, text: l.text }, i === cutterLast);
  });
  for (const l of input.fly) {
    if (l.source === 'app' && l.loggedAt <= cutterEnd) continue;
    const kind: CutLogKind =
      l.source === 'app' ? 'line' : KILL_WORDS.test(l.text) ? 'fail' : 'warn';
    push({ origin: 'fly', kind, loggedAt: l.loggedAt, text: l.text });
  }
  for (const l of input.pump) {
    push({ origin: 'pump', kind: l.kind ?? 'stage', loggedAt: l.loggedAt, text: l.text });
  }
  if (input.exit !== null) {
    const text = exitLineText(input.exit);
    if (text !== null) {
      const latest = all.reduce((m, l) => Math.max(m, l.loggedAt), 0);
      const bad = input.exit.oomKilled === true || (input.exit.exitCode ?? 0) !== 0;
      push(
        {
          origin: 'fly',
          kind: bad ? 'fail' : 'line',
          loggedAt: input.exit.exitedAt ?? latest,
          text,
        },
        true,
      );
    }
  }

  all.sort((a, b) => a.loggedAt - b.loggedAt || a.rank - b.rank || a.order - b.order);
  const strip = ({ rank: _r, order: _o, pinned: _p, ...line }: Pending): CutLogLine => line;
  if (all.length <= CUT_LOG_MAX_LINES) return { lines: all.map(strip), dropped: 0 };

  // Past the cap: the head, the pinned lines that fall between, and a tail shortened by as many.
  const head = all.slice(0, CUT_LOG_HEAD_LINES);
  const rest = all.slice(CUT_LOG_HEAD_LINES);
  // Shortening the tail moves lines into the middle, so settle it until the pinned ones fit.
  let tailCount = CUT_LOG_TAIL_LINES;
  let middleKept = rest.slice(0, rest.length - tailCount).filter((l) => l.pinned);
  while (middleKept.length + tailCount > CUT_LOG_TAIL_LINES) {
    tailCount = CUT_LOG_TAIL_LINES - middleKept.length;
    middleKept = rest.slice(0, rest.length - tailCount).filter((l) => l.pinned);
  }
  const tail = rest.slice(rest.length - tailCount);
  const dropped = all.length - head.length - middleKept.length - tail.length;
  const last = head[head.length - 1] as Pending;
  const warn: CutLogLine = {
    origin: 'pump',
    kind: 'warn',
    loggedAt: last.loggedAt,
    text: `${dropped} line${dropped === 1 ? '' : 's'} in the middle of this log weren't kept`,
  };
  return {
    lines: [...head.map(strip), warn, ...middleKept.map(strip), ...tail.map(strip)],
    dropped,
  };
}

/** Where an attempt's machine-minutes came from (the Convex package's `IMAGERY_MACHINE_MS_SOURCES`). */
export type MachineMsSource = 'fly' | 'cutter' | 'settle';

/**
 * **An attempt's machine time** (D346), from the best source it has: Fly's exit less its start
 * (`fly`); else the cutter log's last stamp less its first (`cutter`); else the settle less the spawn
 * (`settle`, coarse to the pump's three minutes — the page says *about*). Never negative; `null` with
 * nothing to measure from (a spawn never confirmed has no Machine to count).
 */
export function attemptMachineMs(input: {
  startedAt: number | null;
  exitedAt: number | null;
  cutter: readonly CutterLogLine[];
  spawnedAt: number;
  settledAt: number;
  /** False for an attempt with no Machine (refused, never confirmed): nothing ran, nothing counts. */
  ran: boolean;
}): { ms: number; from: MachineMsSource } | null {
  if (!input.ran) return null;
  if (input.startedAt !== null && input.exitedAt !== null && input.exitedAt >= input.startedAt) {
    return { ms: input.exitedAt - input.startedAt, from: 'fly' };
  }
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let stamped = 0;
  for (const l of input.cutter) {
    if (l.loggedAt <= 0) continue;
    stamped++;
    first = Math.min(first, l.loggedAt);
    last = Math.max(last, l.loggedAt);
  }
  if (stamped >= 2) return { ms: last - first, from: 'cutter' };
  return { ms: Math.max(0, input.settledAt - input.spawnedAt), from: 'settle' };
}
