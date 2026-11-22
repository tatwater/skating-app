/**
 * What a run of `seed-inbox` is asked to do, and every reason it refuses before it calls anything.
 *
 * Four modes: the default **dry run** (prints the plan, writes nothing), `--apply` (files it), and
 * `--clear` (prints what the clear would remove) with `--apply` (removes it). Dev only, whatever the
 * mode — the server refuses too, but a run that targets prod should stop here, before any call.
 */

export type Mode = 'dry' | 'apply' | 'clear-dry' | 'clear';

export type Parsed =
  | { ok: true; mode: Mode; operator: string | undefined }
  | { ok: false; message: string };

export const USAGE = 'Usage: seed-inbox [--apply] | --clear [--apply]';

/** The deployment `convex run` would target, as `@skating/run-log`'s `resolveDeployment` tells it. */
export interface Target {
  label: string;
  isDev: boolean;
}

export function parseArgs(
  argv: readonly string[],
  env: { CONVEX_RUN_AS?: string },
  target: Target,
): Parsed {
  const known = new Set(['--apply', '--clear']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0)
    return { ok: false, message: `Unknown argument ${unknown.join(' ')}. ${USAGE}` };
  if (!target.isDev) {
    return {
      ok: false,
      message: `seed-inbox runs only against the dev deployment; this would target ${target.label}.`,
    };
  }
  const apply = argv.includes('--apply');
  const clear = argv.includes('--clear');
  const operator = env.CONVEX_RUN_AS?.trim() || undefined;
  if (apply && !clear && operator === undefined) {
    return {
      ok: false,
      message:
        '--apply needs CONVEX_RUN_AS=<your own Clerk user id> — the admin running this; the moderator acts it seeds are recorded as yours, made through seed-inbox.',
    };
  }
  const mode: Mode = clear ? (apply ? 'clear' : 'clear-dry') : apply ? 'apply' : 'dry';
  return { ok: true, mode, operator };
}

/**
 * Why this Node can't run the seed, or `null` when it can: the repo pins a version (`.node-version`)
 * and pnpm refuses or warns on a different major — the seed's first dev run died on that warning.
 * Compared by major version, as the workspace's `engines` (`26.x`) does.
 */
export function nodeVersionRefusal(wanted: string, running: string): string | null {
  const major = (v: string) => v.trim().replace(/^v/, '').split('.')[0] ?? '';
  const want = major(wanted);
  if (want === '' || major(running) === want) return null;
  return `seed-inbox needs Node ${want} (the repo's .node-version, ${wanted.trim()}); this shell runs ${running}. Switch Node (e.g. \`fnm use\` or \`nvm use\`) and run it again.`;
}
