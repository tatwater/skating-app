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
