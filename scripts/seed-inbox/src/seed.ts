/**
 * The seed's loops, over an injected `call` so they run against a fake in the tests and against
 * `convex run` in the CLI.
 *
 * **The server owns the plan** (`packages/convex/convex/inboxSeed.ts`): `inboxSeed:state` answers
 * which steps are done (each found by its stable seed key), which are ready (with their arguments
 * resolved) and which wait on another or can't be filed on this deployment. The script only files
 * what is ready — each through the public mutation it names, as the fake person it names (their
 * `seed_inbox_<n>` subject) or as the operator (`CONVEX_RUN_AS`), always "via seed-inbox" — and asks
 * again, until nothing is ready. So a second run files nothing new, and a step that failed is tried
 * once a run and recorded, never retried in a loop.
 *
 * These shapes mirror `inboxSeed.ts`'s — re-declared rather than imported, as `@skating/run-log`
 * re-declares the run row's, because a script compiles without the Convex package's generated types.
 */

import type { RunAs } from '@skating/run-log';

/** What every seeded write is made through (D256): "Teagan via seed-inbox". */
export const SEED_VIA = 'seed-inbox';

/** How many times the loop asks for the plan, at most. The plan settles in about six. */
export const MAX_WAVES = 20;

/** How many clear calls one run makes, at most. A full seed clears in about fifty. */
export const MAX_CLEAR_CALLS = 5_000;

export type SeedActor = string; // a fake person's key, 'operator' or 'bare'

export interface SeedCall {
  key: string;
  label: string;
  as: SeedActor;
  clerkUserId?: string;
  fn: string;
  args: Record<string, unknown>;
}

export interface SeedState {
  people: { key: string; displayName: string; profileId: string | null }[];
  bodies: { role: string; name: string | null }[];
  done: string[];
  ready: SeedCall[];
  waiting: { key: string; label: string; on: string }[];
  unavailable: { key: string; label: string; missing: string }[];
}

export interface EnsurePeople {
  created: string[];
  existing: string[];
  applied: boolean;
  /** The operator's role and status, when asked about one; `null` when no profile has that id. */
  operator?: { role: string; status: string } | null;
}

/**
 * Why the operator can't run the seed, in a plain sentence, or `null` when they can. The seed's
 * moderator acts include approving a takedown ask, which removes a body: that takes an admin.
 */
export function operatorRefusal(operator: EnsurePeople['operator']): string | null {
  if (operator === undefined || operator === null) {
    return 'CONVEX_RUN_AS names no one on this deployment — it must be your own Clerk user id.';
  }
  if (operator.status !== 'active') {
    return `CONVEX_RUN_AS names an account that is ${operator.status}, not active.`;
  }
  if (operator.role !== 'admin') {
    return `CONVEX_RUN_AS must be an admin: the seed approves a takedown, which only an admin can do (this account is a ${operator.role}).`;
  }
  return null;
}

export interface ClearAnswer {
  done: boolean;
  removed: Record<string, number>;
}

/** `convex run`, as the loops see it: a function name, its arguments, and who it is made as. */
export type Call = <T>(fn: string, args: unknown, runAs?: RunAs) => T;

/** Who a step goes out as: no identity for an internal call, else a person through this script. */
export function runAsFor(call: SeedCall, operator: string | undefined): RunAs | undefined {
  if (call.as === 'bare') return undefined;
  const as = call.as === 'operator' ? operator : call.clerkUserId;
  if (as === undefined) throw new Error(`No one to file ${call.key} as.`);
  return { as, via: SEED_VIA };
}

/** One filed step, or one that failed, for the run log. */
export interface Filed {
  key: string;
  label: string;
  as: SeedActor;
  fn: string;
  result?: unknown;
  error?: string;
}

export interface SeedRun {
  people: EnsurePeople;
  waves: Filed[][];
  /** The plan as it stood when nothing more was ready. */
  last: SeedState;
  counts: {
    filed: number;
    failed: number;
    done: number;
    waiting: number;
    unavailable: number;
    ready: number;
  };
}

/** The dry run: who would be created, and the plan as it stands. Writes nothing. */
export function planSeed(call: Call): { people: EnsurePeople; state: SeedState } {
  const people = call<EnsurePeople>('inboxSeed:ensurePeople', {});
  const state = call<SeedState>('inboxSeed:state', {});
  return { people, state };
}

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

/** The first line of an error, which the CLI's runner makes the server's own sentence; bounded. */
export function errorLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return logSafe(
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? 'unknown error',
  );
}

/**
 * **File the plan.** Ensure the people, then: ask for the plan, file every ready step not already
 * tried this run, ask again — until nothing new is ready, or {@link MAX_WAVES}.
 */
export function applySeed(
  call: Call,
  operator: string | undefined,
  onFiled: (f: Filed) => void = () => {},
): SeedRun {
  // Who the operator is, before anything is written: a run that would fail at its first moderator
  // act stops here instead.
  const check = call<EnsurePeople>('inboxSeed:ensurePeople', {
    ...(operator !== undefined ? { operator } : {}),
  });
  const refusal = operatorRefusal(operator === undefined ? null : check.operator);
  if (refusal !== null) throw new Error(refusal);
  const people = call<EnsurePeople>('inboxSeed:ensurePeople', { apply: true });
  const tried = new Set<string>();
  const waves: Filed[][] = [];
  let last = call<SeedState>('inboxSeed:state', {});
  for (let wave = 0; wave < MAX_WAVES; wave++) {
    const ready = last.ready.filter((c) => !tried.has(c.key));
    if (ready.length === 0) break;
    const filed: Filed[] = [];
    for (const step of ready) {
      tried.add(step.key);
      const row: Filed = { key: step.key, label: step.label, as: step.as, fn: step.fn };
      try {
        row.result = call(step.fn, step.args, runAsFor(step, operator));
      } catch (err) {
        row.error = errorLine(err);
      }
      filed.push(row);
      onFiled(row);
    }
    waves.push(filed);
    last = call<SeedState>('inboxSeed:state', {});
  }
  const all = waves.flat();
  return {
    people,
    waves,
    last,
    counts: {
      filed: all.filter((f) => f.error === undefined).length,
      failed: all.filter((f) => f.error !== undefined).length,
      done: last.done.length,
      waiting: last.waiting.length,
      unavailable: last.unavailable.length,
      // Steps the plan still offered when the loop stopped (each tried once this run and failed, or
      // past the wave cap): never counted as done.
      ready: last.ready.length,
    },
  };
}

export interface ClearRun {
  calls: number;
  removed: Record<string, number>;
  done: boolean;
}

/** **Remove the seed**: `inboxSeed:clear` again and again until it is done. */
export function applyClear(call: Call, onCall: (a: ClearAnswer) => void = () => {}): ClearRun {
  const removed: Record<string, number> = {};
  for (let calls = 1; calls <= MAX_CLEAR_CALLS; calls++) {
    const answer = call<ClearAnswer>('inboxSeed:clear', {});
    onCall(answer);
    for (const [table, n] of Object.entries(answer.removed))
      removed[table] = (removed[table] ?? 0) + n;
    if (answer.done) return { calls, removed, done: true };
    // A call that removed nothing would never finish: say so rather than spin.
    if (!Object.values(answer.removed).some((n) => n > 0)) {
      throw new Error(
        `The clear stopped making progress after ${calls} calls; nothing was skipped — run it again.`,
      );
    }
  }
  return { calls: MAX_CLEAR_CALLS, removed, done: false };
}

/** The plan, as the dry run prints it. */
export function describePlan(people: EnsurePeople, state: SeedState): string[] {
  const lines: string[] = [];
  lines.push(
    people.created.length > 0
      ? `would create ${people.created.length} fake people: ${people.created.join(', ')}`
      : `the ${people.existing.length} fake people exist`,
  );
  for (const b of state.bodies)
    lines.push(`body ${b.role.padEnd(10)} ${b.name ?? '— none on this deployment'}`);
  lines.push(
    `steps done ${state.done.length} · ready ${state.ready.length} · waiting ${state.waiting.length} · unavailable ${state.unavailable.length}`,
  );
  for (const c of state.ready)
    lines.push(`ready       ${c.key.padEnd(22)} ${c.fn} as ${c.as} — ${c.label}`);
  for (const w of state.waiting)
    lines.push(`waiting     ${w.key.padEnd(22)} on ${w.on} — ${w.label}`);
  for (const u of state.unavailable)
    lines.push(`unavailable ${u.key.padEnd(22)} needs ${u.missing} — ${u.label}`);
  return lines;
}

/** A tally as one line: `reports 8 · contentFlags 18`. */
export function tally(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  return entries.length === 0 ? 'nothing' : entries.map(([k, n]) => `${k} ${n}`).join(' · ');
}

/** The run log's file name: the mode and the moment, sortable. */
export function runLogName(mode: string, now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${mode}.json`;
}
