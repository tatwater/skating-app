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

import { logSafe, type RunAs } from '@skating/run-log';

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
  /** A photo step: its two files are uploaded first, and their ids passed (`Upload`). */
  upload?: true;
}

/**
 * Upload a photo step's two files as its person — the full image and its thumbnail — and answer their
 * stored ids, as the app's own upload does (`photos:generateUploadUrl`, then a POST of the bytes).
 * The CLI's makes real HTTP POSTs; never prints, logs or returns the upload address.
 */
export type Upload = (
  step: SeedCall,
  runAs: RunAs | undefined,
) => { storageId: string; thumbStorageId: string };

/** The uploader when none is given: a plan with a photo step can't be filed without one. */
const noUpload: Upload = (step) => {
  throw new Error(`${step.key} uploads photos, and this run has no uploader.`);
};

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
  /** Seed photos the call left whole because a rotation of theirs was in flight or a file owed. */
  waiting?: number;
  /** When the last rotation still running must be over (its action's lifetime), in ms. */
  readyBy?: number;
  /** Of those, the photos with a file whose delete failed and is owed (Machinery retries it). */
  owed?: number;
}

/** What a waiting clear is waiting on, in words — the CLI's line, and its give-up message. */
export function waitingOn(a: ClearAnswer): string {
  const parts: string[] = [];
  const rotating = (a.waiting ?? 0) - (a.owed ?? 0);
  if (rotating > 0) {
    const by = a.readyBy !== undefined ? `, over by ${new Date(a.readyBy).toISOString()}` : '';
    parts.push(`${rotating} seed photo(s) whose file is being moved${by}`);
  }
  if ((a.owed ?? 0) > 0) {
    parts.push(
      `${a.owed} seed photo(s) with a file whose delete failed and is owed (Machinery's photoRotation job retries it)`,
    );
  }
  return parts.join('; ');
}

/** How long the clear waits for a photo's rotation before asking again, and how many times at most. */
export const PHOTO_WAIT_MS = 5_000;
export const MAX_PHOTO_WAITS = 120;

/** Block for `ms` (the script is synchronous, as `convex run` calls are). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  /** Files this step uploaded that it could not release after failing (its stored ids, never a URL). */
  stranded?: string[];
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
  /** Uploads a failed photo step left that could not be released: what to finish by hand. */
  stranded: { key: string; as: SeedActor; subject?: string; storageIds: string[] }[];
  /** The run stopped early on an interrupt (Ctrl-C), after releasing what its step had uploaded. */
  interrupted: boolean;
}

/** What `photos:removeBlob` says of a file a photo row already names (the clear takes those). */
export const BLOB_ATTACHED = 'Only a fresh upload no photo uses can be removed this way.';

/**
 * **Release uploads a failed photo step made** — as its person, through the app's own cleanup for a
 * fresh unattached upload (`photos:removeBlob`). Answers the ids it could not release: never one a
 * photo row already names (a `photos:create` that went through though its answer was lost — the
 * clear takes that photo, files and all).
 */
export function releaseUploads(call: Call, storageIds: readonly string[], runAs?: RunAs): string[] {
  const left: string[] = [];
  for (const storageId of storageIds) {
    try {
      call('photos:removeBlob', { storageId }, runAs);
    } catch (err) {
      if (!errorLine(err).includes(BLOB_ATTACHED)) left.push(storageId);
    }
  }
  return left;
}

/** A photo step's upload that failed partway, with what it uploaded and could not release. */
export class UploadFailed extends Error {
  constructor(
    message: string,
    readonly stranded: readonly string[],
  ) {
    super(message);
  }
}

/**
 * The summary's lines for uploads a failed step left: each file by its stored id (never an address),
 * with the one command that finishes it by hand — within a day, while it is still a fresh upload.
 */
export function strandedLines(stranded: SeedRun['stranded']): string[] {
  return stranded.flatMap((s) =>
    s.storageIds.map(
      (id) =>
        `left on the deployment by ${s.key} (as ${s.as}): file ${id} — remove it within a day: ` +
        `pnpm --filter @skating/convex exec convex run photos:removeBlob '${JSON.stringify({ storageId: id })}'` +
        (s.subject ? ` --identity '${JSON.stringify({ subject: s.subject, via: SEED_VIA })}'` : ''),
    ),
  );
}

/**
 * **What the kept run log holds of a run** — everything but the stranded files' stored ids: the log
 * lives on in `runs/`, and a stored id works like a key to its bytes, so it is said once, on the
 * operator's terminal ({@link strandedLines}), and the log keeps only how many each step left.
 */
export function runRecord(run: SeedRun) {
  return {
    ...run,
    // Each step's own row too: a failed photo step's `stranded` becomes how many it left.
    waves: run.waves.map((wave) =>
      wave.map(({ stranded, ...row }) =>
        stranded === undefined ? row : { ...row, strandedFiles: stranded.length },
      ),
    ),
    stranded: run.stranded.map((s) => ({ key: s.key, as: s.as, files: s.storageIds.length })),
  };
}

/** One turn of the event loop: an interrupt's handler runs here, between steps. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The dry run: who would be created, and the plan as it stands. Writes nothing. */
export function planSeed(call: Call): { people: EnsurePeople; state: SeedState } {
  const people = call<EnsurePeople>('inboxSeed:ensurePeople', {});
  const state = call<SeedState>('inboxSeed:state', {});
  return { people, state };
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
export async function applySeed(
  call: Call,
  operator: string | undefined,
  onFiled: (f: Filed) => void = () => {},
  upload: Upload = noUpload,
  /** Asked between steps: true once the run was interrupted (the CLI's Ctrl-C), and it stops. */
  interrupted: () => boolean = () => false,
): Promise<SeedRun> {
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
  const stranded: SeedRun['stranded'] = [];
  let stopped = false;
  for (let wave = 0; wave < MAX_WAVES && !stopped; wave++) {
    const ready = last.ready.filter((c) => !tried.has(c.key));
    if (ready.length === 0) break;
    const filed: Filed[] = [];
    for (const step of ready) {
      tried.add(step.key);
      const row: Filed = { key: step.key, label: step.label, as: step.as, fn: step.fn };
      let runAs: RunAs | undefined;
      let uploaded: string[] = [];
      try {
        runAs = runAsFor(step, operator);
        // A photo step: its files first, as its person; only their ids reach the call (and the log
        // holds neither them nor the upload address — just the call's own result).
        let args = step.args;
        if (step.upload) {
          const ids = upload(step, runAs);
          uploaded = [ids.storageId, ids.thumbStorageId];
          args = { ...args, ...ids };
        }
        row.result = call(step.fn, args, runAs);
      } catch (err) {
        row.error = errorLine(err);
        // Whatever it uploaded is released (a fresh upload no row names lies outside every sweep
        // and the clear); what can't be is said, by stored id, to finish by hand.
        const left =
          err instanceof UploadFailed
            ? [...err.stranded]
            : uploaded.length > 0
              ? releaseUploads(call, uploaded, runAs)
              : [];
        if (left.length > 0) {
          row.stranded = left;
          stranded.push({
            key: step.key,
            as: step.as,
            ...(runAs ? { subject: runAs.as } : {}),
            storageIds: left,
          });
        }
      }
      filed.push(row);
      onFiled(row);
      // Between steps, the event loop turns: an interrupt's handler runs, and the run stops here —
      // the step it cut short already failed and released its uploads above.
      await tick();
      if (interrupted()) {
        stopped = true;
        break;
      }
    }
    waves.push(filed);
    last = call<SeedState>('inboxSeed:state', {});
  }
  const all = waves.flat();
  return {
    stranded,
    interrupted: stopped,
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
export function applyClear(
  call: Call,
  onCall: (a: ClearAnswer) => void = () => {},
  wait: (ms: number) => void = sleepSync,
): ClearRun {
  const removed: Record<string, number> = {};
  let waits = 0;
  for (let calls = 1; calls <= MAX_CLEAR_CALLS; calls++) {
    const answer = call<ClearAnswer>('inboxSeed:clear', {});
    onCall(answer);
    for (const [table, n] of Object.entries(answer.removed))
      removed[table] = (removed[table] ?? 0) + n;
    if (answer.done) return { calls, removed, done: true };
    // A seed photo whose file is being moved (a takedown's rotation) is left until it lands: the
    // clear waits for it rather than race it, a few seconds at a time, for up to ten minutes.
    if ((answer.waiting ?? 0) > 0) {
      if (++waits > MAX_PHOTO_WAITS) {
        throw new Error(
          `After ${Math.round((MAX_PHOTO_WAITS * PHOTO_WAIT_MS) / 60_000)} minutes the clear is still waiting on ${waitingOn(answer)}. Nothing was skipped: run the clear again once that is done.`,
        );
      }
      wait(PHOTO_WAIT_MS);
      continue;
    }
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
