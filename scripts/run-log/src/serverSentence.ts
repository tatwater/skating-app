/**
 * **The server's sentence from a failed `convex run`** — one function for every script that shells
 * out to the CLI (`convexRun`, and through it the loaders and `seed-inbox`), so a run log records why
 * a call failed in the server's words, never pnpm's wrapper line (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
 * Command failed …`), and never an environment value.
 */

/** The longest error a run log or summary carries: a sentence, never a dump. */
export const MAX_ERROR_LENGTH = 300;

// The CLI colors its output when it can: escape codes are never part of a sentence.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape code is what is matched
const ANSI = /\u001b\[[0-9;]*m/g;

/** The server's boilerplate before its sentence: `Error: [CONVEX …] [Request ID: …] Server Error`. */
const BOILERPLATE = /^(?:Error: )?(?:\[CONVEX [^\]]*\] )?\[Request ID: [^\]]*\] Server Error$/;

/** Lines that say nothing about why: pnpm's wrapper, a stack frame, the CLI's function list. */
const noise = (l: string) =>
  l === '' ||
  l.startsWith('Command failed') ||
  l.includes('ERR_PNPM') ||
  l.startsWith('at ') ||
  l.startsWith('\u2022') ||
  l === 'Available functions:' ||
  l === 'No functions found.' ||
  l === 'undefined' ||
  BOILERPLATE.test(l);

/**
 * A sentence fit for the run log: anything shaped like an environment assignment (`NAME=value`) kept
 * as its name only, and bounded to {@link MAX_ERROR_LENGTH}.
 */
export function logSafe(text: string): string {
  const named = text.replace(/\b([A-Z][A-Z0-9_]{2,})=\S+/g, '$1=…').trim();
  return named.length > MAX_ERROR_LENGTH ? `${named.slice(0, MAX_ERROR_LENGTH - 1)}…` : named;
}

/**
 * The server's own sentence from what `convex run` wrote to stderr — never pnpm's wrapper line:
 *
 * - a function's own refusal: the `Uncaught ConvexError: …` (or `Uncaught Error: …`) line's text;
 * - a call the CLI couldn't make (`Failed to run function "…":` — a name the deployment lacks, or an
 *   internal one called as a person): the lines after it, without the request boilerplate, up to the
 *   list of available functions the CLI prints next;
 * - else the last line that says something (not pnpm's, not a stack frame).
 *
 * Bounded, and never an environment value ({@link logSafe}).
 */
export function serverSentence(stderr: string): string {
  const lines = stderr
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim());
  for (const line of lines) {
    const m = line.match(/Uncaught (?:ConvexError|Error): (.*)$/);
    if (m?.[1]) return logSafe(m[1]);
  }
  const failed = lines.findIndex((l) => /^(?:✖ )?Failed to run function /.test(l));
  if (failed !== -1) {
    const said: string[] = [];
    for (const line of lines.slice(failed + 1)) {
      if (line === '' || line === 'Available functions:') break;
      if (!noise(line)) said.push(line.replace(/^Error: /, ''));
    }
    return logSafe(said.length > 0 ? said.join(' ') : (lines[failed] as string));
  }
  const useful = lines.filter((l) => !noise(l));
  return logSafe(useful.at(-1) ?? 'convex run failed with no message');
}
