/**
 * **What the operator reads, on every way a run ends** — the apply's and the clear's terminal lines,
 * apart from the CLI glue so they are tested. Whatever the operator needs to act on is said the
 * moment it is known (a failed step's server sentence, the uploads it couldn't release, what the clear
 * is waiting on) and again in a summary printed in `finally`: after a normal return, a throw from any
 * later call, or an interrupt. The kept run log holds counts only (`runRecord`), never a stored id.
 */

import {
  applyClear,
  applySeed,
  type Call,
  type ClearAnswer,
  type Filed,
  runRecord,
  type SeedRun,
  type SeedState,
  strandedLines,
  tally,
  type Upload,
  waitingOn,
} from './seed';

/** Where a run's words and its log go. */
export interface Out {
  say: (line: string) => void;
  /** Keep the run's record; answers where it went. */
  writeLog: (mode: string, record: unknown) => string;
  target: string;
}

const filedLine = (f: Filed) =>
  `${f.error === undefined ? 'filed ' : 'FAILED'} ${f.key.padEnd(22)} ${f.fn} as ${f.as}${f.error ? ` — ${f.error}` : ''}`;

/** File the plan, saying each step as it goes; the summary on every exit path. Answers the exit code. */
export async function applyAndReport(
  call: Call,
  operator: string | undefined,
  upload: Upload,
  interrupted: () => boolean,
  out: Out,
): Promise<number> {
  const { say } = out;
  const stranded: SeedRun['stranded'] = [];
  let state: SeedState | null = null;
  let run: SeedRun | null = null;
  try {
    run = await applySeed(call, operator, (f) => say(filedLine(f)), upload, interrupted, {
      onStranded: (s) => {
        stranded.push(s);
        for (const line of strandedLines([s])) say(line);
      },
      onState: (s) => {
        state = s;
      },
    });
    const log = out.writeLog('apply', { target: out.target, ...runRecord(run) });
    say(`people created ${run.people.created.length}`);
    say(
      `filed ${run.counts.filed} · failed ${run.counts.failed} · done ${run.counts.done} · still ready ${run.counts.ready} · waiting ${run.counts.waiting} · unavailable ${run.counts.unavailable}`,
    );
    say(`run log ${log}`);
    return run.counts.failed > 0 || run.interrupted ? 1 : 0;
  } finally {
    // Every exit path: what is still to act on, as far as the run got.
    const last = state as SeedState | null;
    for (const u of last?.unavailable ?? []) say(`unavailable ${u.key} — needs ${u.missing}`);
    for (const line of strandedLines(stranded)) say(line);
    if (run?.interrupted || interrupted()) {
      say('interrupted: the run stopped early; apply again to finish it');
    } else if (run === null) {
      say('the run stopped on an error; what it filed stays — apply again to finish it');
    }
  }
}

/** Remove the seed, saying what it waits on as it goes; what it removed on every exit path. */
export function clearAndReport(call: Call, out: Out, wait?: (ms: number) => void): number {
  const { say } = out;
  const removed: Record<string, number> = {};
  let lastWait: ClearAnswer | null = null;
  let done = false;
  try {
    const run = applyClear(
      call,
      (a) => {
        for (const [table, n] of Object.entries(a.removed))
          removed[table] = (removed[table] ?? 0) + n;
        if ((a.waiting ?? 0) > 0) {
          lastWait = a;
          say(`waiting on ${waitingOn(a)}`);
        } else lastWait = null;
      },
      wait,
    );
    done = run.done;
    const log = out.writeLog('clear', { target: out.target, ...run });
    say(`run log ${log}`);
    return run.done ? 0 : 1;
  } finally {
    say(`removed: ${tally(removed)}`);
    const waiting = lastWait as ClearAnswer | null;
    if (!done && waiting !== null) say(`still waiting on ${waitingOn(waiting)}`);
    if (!done) say('the clear is not done; run it again to finish it');
  }
}
