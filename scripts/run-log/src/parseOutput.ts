/**
 * Parse what `convex run` printed on stdout.
 *
 * Its own file so `convexRun.ts` can stay excluded from coverage as untestable subprocess glue
 * while this — the part that actually had a bug — is tested.
 */

/**
 * Parse what `convex run` printed.
 *
 * Split out from the subprocess call because it is the part with a bug in it, and it had one: the
 * original only recognised `{…}` and `"…"`, so an **array** return (any list query) fell through to
 * a regex that matched the first `{…}` *inside* the array and parsed one element as the whole
 * result. Here that threw; the version of this mistake that silently succeeds is much worse.
 */
export function parseConvexOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined as T;
  // A function can return an object, an array, a bare string (an inserted id), a number or a bool.
  if (/^[[{"]/.test(trimmed) || /^-?\d/.test(trimmed) || /^(true|false|null)$/.test(trimmed)) {
    return JSON.parse(trimmed) as T;
  }
  // Something else reached stdout ahead of the value — take the last JSON-looking block. Arrays are
  // tried first: an array of objects also matches the object pattern, and matching that would hand
  // back one element dressed as the whole answer.
  const candidate =
    trimmed.match(/\[[\s\S]*\]/)?.[0] ??
    trimmed.match(/\{[\s\S]*\}/)?.[0] ??
    trimmed.match(/"[^"]*"/)?.[0];
  if (candidate === undefined)
    throw new Error(`convex run returned unparseable output: ${trimmed}`);
  return JSON.parse(candidate) as T;
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
