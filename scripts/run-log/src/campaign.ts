/**
 * **The corpus campaign's own row** (D341, B01-8a) — `scripts/etl/run-corpus.sh` opens it before its
 * first pass, beats it between passes, and closes it with its exit status, so Machinery can draw the
 * campaign whole: what it was asked (its flags), what it planned (the passes in order, a skipped one
 * with why), where it is, and how it ended. Each pass's own row points at it (`RUN_CORPUS_PARENT`).
 *
 *   pnpm --silent --filter @skating/run-log campaign open <campaignId> --plan=<pass,…> \
 *       [--hand=<pass,…>] [--skipped=<pass>:<why>]… [-- <the script's flags>…]
 *       → prints the new row's id on stdout, and nothing else
 *   pnpm --silent --filter @skating/run-log campaign pass <runId> <pass>
 *       → a heartbeat and a "starting" line; prints `stop` when the console asked the campaign to stop
 *   pnpm --silent --filter @skating/run-log campaign skip <runId> <pass> <why…>
 *   pnpm --silent --filter @skating/run-log campaign close <runId> --exit=<code> [--last-pass=<pass>]
 *
 * **Every verb exits 0 whatever Convex says** — the receipt rule of `cli.ts`: a campaign must never
 * fail because its row couldn't be written. A deployment that predates the campaign row refuses the
 * open; the CLI says so on stderr, prints nothing, and the script carries on with no campaign row (its
 * passes then list on their own). Only a malformed command line exits non-zero, and the script ignores
 * that too.
 */

import type { DeploymentTarget } from './deployment';
import type { ConvexCaller, RunEventLine } from './runLogger';

import process from 'node:process';
import { convexRun } from './convexRun';
import { resolveDeployment } from './deployment';
import { eventText, readDirectives } from './runLogger';

/** A planned pass, as the campaign row stores it. */
export interface PlannedPass {
  pass: string;
  by: 'script' | 'hand';
  skipped?: string;
}

/** What the CLI needs from the world — injectable, so every verb is tested without a deployment. */
export interface CampaignDeps {
  call: ConvexCaller;
  target: () => DeploymentTarget;
  /** stdout: the run id from `open`, `stop` from `pass`. */
  out: (text: string) => void;
  /** stderr. */
  warn: (text: string) => void;
  now?: () => number;
}

const USAGE = [
  'usage: campaign open <campaignId> --plan=<pass,…> [--hand=<pass,…>] [--skipped=<pass>:<why>]… [-- <flags>…]',
  '       campaign pass <runId> <pass>',
  '       campaign skip <runId> <pass> <why…>',
  '       campaign close <runId> --exit=<code> [--last-pass=<pass>]',
].join('\n');

/** `--name=value`'s value, the last one given. */
function option(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return [...args]
    .reverse()
    .find((a) => a.startsWith(prefix))
    ?.slice(prefix.length);
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * The plan from the command line: the script's passes in order, then the by-hand ones, each skipped
 * pass with its reason. A skip naming a pass that isn't planned is dropped — the plan is the list.
 */
export function planOf(args: readonly string[]): PlannedPass[] {
  const skipped = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith('--skipped=')) continue;
    const value = arg.slice('--skipped='.length);
    const at = value.indexOf(':');
    if (at <= 0) continue;
    skipped.set(value.slice(0, at), value.slice(at + 1).trim() || 'skipped');
  }
  const entry = (pass: string, by: PlannedPass['by']): PlannedPass => {
    const why = skipped.get(pass);
    return why === undefined ? { pass, by } : { pass, by, skipped: why };
  };
  return [
    ...list(option(args, 'plan')).map((p) => entry(p, 'script')),
    ...list(option(args, 'hand')).map((p) => entry(p, 'hand')),
  ];
}

/** The error a campaign that ended non-zero closes with. */
export function stoppedAt(exitCode: number, lastPass: string | undefined): string {
  return lastPass
    ? `Stopped at ${lastPass} (exit ${exitCode})`
    : `Stopped before its first pass (exit ${exitCode})`;
}

export function campaignFromCommandLine(args: readonly string[], deps: CampaignDeps): number {
  const [verb, subject, ...rest] = args;
  const now = deps.now ?? Date.now;
  const line = (kind: RunEventLine['kind'], text: string): RunEventLine => ({
    kind,
    text: eventText(text),
    loggedAt: now(),
  });
  /** Bookkeeping never breaks the campaign: a refused write is a warning, never an exit status. */
  const attempt = <T>(what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      deps.warn(
        `[run-log] campaign ${what} failed (the campaign itself is unaffected): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return undefined;
    }
  };
  const append = (runId: string, events: RunEventLine[]) =>
    attempt('log', () => deps.call('runEvents:append', { runId, events }));

  if (subject === undefined || subject.length === 0) {
    deps.warn(`${USAGE}\n`);
    return 2;
  }

  switch (verb) {
    case 'open': {
      const dash = rest.indexOf('--');
      const options = dash === -1 ? rest : rest.slice(0, dash);
      const flags = dash === -1 ? [] : rest.slice(dash + 1);
      const plan = planOf(options);
      if (plan.length === 0) {
        deps.warn(`${USAGE}\n`);
        return 2;
      }
      const target = deps.target();
      const runId = attempt('open', () =>
        deps.call<string>('importRuns:start', {
          kind: 'corpus_campaign',
          label: `Corpus campaign ${subject}`,
          campaignId: subject,
          deployment: target.label,
          isProd: target.isProd,
          stages: [],
          // A campaign's intent is always the whole corpus; what it achieved is its passes' rows.
          scope: { pass: 'full-canonical', complete: true },
          campaign: { flags, plan },
        }),
      );
      if (typeof runId !== 'string' || runId.length === 0) return 0;
      const script = plan.filter((p) => p.by === 'script');
      const skips = script.filter((p) => p.skipped !== undefined);
      append(runId, [
        line(
          'start',
          `Campaign started · ${flags.length > 0 ? flags.join(' ') : 'no flags'} · ` +
            `${script.length} passes planned${skips.length > 0 ? `, ${skips.length} to skip` : ''}`,
        ),
        ...skips.map((p) => line('stage', `Pass ${p.pass} will be skipped: ${p.skipped}`)),
      ]);
      deps.out(`${runId}\n`);
      return 0;
    }
    case 'pass': {
      const pass = rest[0];
      if (pass === undefined) break;
      attempt('heartbeat', () => deps.call('importRuns:progress', { runId: subject }));
      const answer = append(subject, [line('stage', `Pass ${pass} starting`)]);
      if (readDirectives(answer).stop) {
        append(subject, [
          line('warn', `Asked to stop in the console: stopping before pass ${pass}`),
        ]);
        deps.out('stop\n');
      }
      return 0;
    }
    case 'skip': {
      const [pass, ...why] = rest;
      if (pass === undefined) break;
      append(subject, [
        line('stage', `Pass ${pass} skipped${why.length > 0 ? `: ${why.join(' ')}` : ''}`),
      ]);
      return 0;
    }
    case 'close': {
      const exitText = option(rest, 'exit');
      const exitCode = Number(exitText);
      if (exitText === undefined || !Number.isInteger(exitCode)) break;
      const lastPass = option(rest, 'last-pass') || undefined;
      const status = exitCode === 0 ? 'succeeded' : 'failed';
      const error = exitCode === 0 ? undefined : stoppedAt(exitCode, lastPass);
      const base = { runId: subject, status, ...(error !== undefined && { error }) };
      const campaign = { exitCode, ...(lastPass !== undefined && { lastPass }) };
      const closed = attempt('close', () => {
        deps.call('importRuns:finish', { ...base, campaign });
        return true;
      });
      // A finish that refused the exit code still closes the row with its status.
      if (closed === undefined) attempt('close', () => deps.call('importRuns:finish', base));
      append(subject, [line('close', error === undefined ? 'Succeeded' : `Failed: ${error}`)]);
      return 0;
    }
  }
  deps.warn(`${USAGE}\n`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = campaignFromCommandLine(process.argv.slice(2), {
    call: convexRun,
    target: resolveDeployment,
    out: (text) => process.stdout.write(text),
    warn: (text) => process.stderr.write(text),
  });
}
