/**
 * Parse what `convex run` printed on stdout.
 *
 * Its own file so `convexRun.ts` can stay excluded from coverage as untestable subprocess glue
 * while this — the part that actually had a bug — is tested.
 */

/** Terminal color and cursor codes, which pnpm and the Convex CLI add when they think stdout is a TTY. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** A line a top-level JSON value can begin on: unindented, opening a value. */
const VALUE_START = /^[[{"\-0-9tfn]/;

/**
 * Parse what `convex run` printed.
 *
 * **The rule: the function's result is the longest run of whole, unindented-edged lines that parses
 * as one JSON value.** `convex run` prints the return value alone, pretty-printed, as whole lines: a
 * top-level object or array opens and closes at column 0 with everything inside indented, and a
 * string, number or boolean is one line. Anything else on stdout is a whole line of its own — pnpm's
 * `[WARN] Unsupported engine … wanted: {"node":"26.x"} (current: …)`, which the seed's first dev run
 * met, carries JSON *inside* a line and so never parses as a block. A parser that takes the first
 * brace it sees picks that warning up; this one can't, wherever the warning sits — before the result,
 * after it, or both — and ANSI codes are stripped first. Among candidate blocks the longest wins, so a
 * one-line element inside a multi-line array never stands in for the array.
 *
 * Split out from the subprocess call because it is the part with bugs in it: the original only
 * recognized `{…}` and `"…"`, so an array return fell through to a regex that matched one element.
 */
export function parseConvexOutput<T>(stdout: string): T {
  const text = stdout.replace(ANSI, '').replace(/\r\n?/g, '\n');
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Not the value alone: find it among the lines.
  }
  const lines = text.split('\n');
  const edge = (line: string) => line.length > 0 && line === line.trimStart();
  let best: { from: number; to: number; value: unknown } | undefined;
  for (let from = 0; from < lines.length; from++) {
    const first = lines[from] ?? '';
    if (!edge(first) || !VALUE_START.test(first)) continue;
    for (let to = from; to < lines.length; to++) {
      if (!edge(lines[to] ?? '')) continue;
      let value: unknown;
      try {
        value = JSON.parse(lines.slice(from, to + 1).join('\n'));
      } catch {
        continue;
      }
      if (!best || to - from >= best.to - best.from) best = { from, to, value };
    }
  }
  if (best === undefined) throw new Error(`convex run returned unparseable output: ${trimmed}`);
  return best.value as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure reasons that fit in a run row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The longest a single failure reason may be on a run row.
 *
 * **A document cap, expressed per record.** Convex refuses a document over 1 MiB, and a run row
 * carries every itemized failure a pass recorded — so an unbounded reason turns "the pass failed 22
 * times" into "the run row could not be written", which is the worst available outcome: the
 * mechanism that records failures failing precisely when there are failures.
 *
 * 600 characters holds a Convex `ArgumentValidationError` in full — the `Path`, the offending
 * `Value` and the `Validator` it missed, which is the whole diagnosis — with room to spare.
 */
export const MAX_FAILURE_REASON_CHARS = 600;

/**
 * Reduce a subprocess error to the part that diagnoses it.
 *
 * ## Measured, on the 2026-08-08 campaign
 *
 * `execSync` throws with `Command failed: <the entire command line>`, and for the canonical loader
 * that command line is **150 water bodies of GeoJSON**. Nineteen batches failed, each recorded its
 * whole argv as the reason, and the run row reached **1.65 MiB** — so `importRuns:progress` threw
 * `Value is too large` and the failure record was lost. `importRuns:finish` then squeaked in at
 * 861,663 bytes with a `Large document written` warning, which is the same bug not quite firing.
 *
 * The command echo is also the *least* informative part: the caller already knows what it ran. What
 * diagnoses the failure is what the server said back, which is everything after it.
 *
 * So: drop the argv, keep the diagnosis, and cap what is left. Truncation is marked rather than
 * silent — a reason that has been cut and does not say so reads as a complete message that happens
 * to end oddly.
 */
export function failureReason(message: string, cap = MAX_FAILURE_REASON_CHARS): string {
  // `Command failed: <argv>` is one line however long the argv is, so dropping that single line
  // removes the payload and keeps every line the server wrote.
  const withoutArgv = message
    .split('\n')
    .filter((line) => !line.startsWith('Command failed:'))
    .join('\n')
    .trim();
  // If the whole message WAS the command echo, there is nothing else to report — keep a bounded
  // head of it rather than returning empty, because "it failed and we saved nothing" is worse.
  const useful = withoutArgv.length > 0 ? withoutArgv : message.trim();
  if (useful.length <= cap) return useful;
  return `${useful.slice(0, cap)}… [truncated ${useful.length - cap} chars]`;
}
