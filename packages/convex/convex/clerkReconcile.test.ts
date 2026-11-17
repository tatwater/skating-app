/**
 * The daily Clerk ban-lock reconcile (B01-4k, D277). Each of the two gaps `setBanned` leaves — a run
 * that dies after Clerk's answer, and a lost answer Clerk applies after its retry — is reproduced
 * first (Clerk ends out of step), then repaired by one pass; the pass pages both sides, backs off,
 * leaves people being deleted and Clerk users with no profile alone, writes no audit row, sends
 * nothing on a dry run, and never undoes a newer change when it races a sync in flight. No real call
 * leaves a test: `fetch` is a fake Clerk.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { CLERK_TIMEOUT_MS, SETTLE_ROUNDS } from './clerkAdmin';
import {
  CLERK_PAGE,
  EMPTY_TALLY,
  MAX_READS_PER_RUN,
  MAX_REPAIRS_PER_RUN,
  REPAIR_RETENTION_MS,
  REPAIR_SPACING_MS,
  RUN_KEY,
  type RunOutcome,
} from './clerkReconcile';
import { NOTIFICATION_PREF_DEFAULTS } from './lib/enums';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type Status = 'active' | 'suspended' | 'banned' | 'deleting' | 'deleted';

/**
 * convex-test fires a scheduled function on a real timer at its time, so a repair (spaced from the
 * run's start, the first at once) would run on its own beside the drain below — or, held by the fake,
 * never end. Faked timers hold every scheduled job for the drain to run, once each; the fake's waits
 * yield with `setImmediate`, which stays real.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** When the fake's first user was created; each next one a second later. */
const CREATED_FROM = Date.UTC(2026, 0, 1);

/** One real event-loop turn (timers are faked here). */
const turn = () => new Promise<void>((r) => setImmediate(r));

// ── A fake Clerk ────────────────────────────────────────────────────────────────────────────────

/** What a held request is released with. */
type How =
  | 'ok' // applied, answered
  | 'fail' // not applied, answered 503
  | 'lost' // applied, the answer lost (a thrown fetch)
  | 'late' // the answer lost now (a thrown fetch); applied later, by `applyLate`
  | 'die' // applied, and the run never hears back — it died before its re-read
  | number; // a GET answered with this status

interface Held {
  method: string;
  url: URL;
  done: boolean;
  release: (how?: How) => void;
}

/**
 * A Clerk with users, a banned flag and a creation time each, and the two endpoints the code calls:
 * `GET /users` (by `user_id`, or `banned=true`, with `limit` — defaulting to 10 as Clerk's does — and
 * `created_at_before`, newest first; ties in the order they were added) and `POST /users/{id}/ban|unban`
 * (404 for a user it lacks). With `hold`, every request waits to be released, in any order, with any
 * {@link How}.
 */
function fakeClerk(opts: { hold?: boolean } = {}) {
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
  // The shared timeout's signal, never fired: a held request waits as long as the test says.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
  const users = new Map<string, { banned: boolean; created: number }>();
  let created = 0;
  const state = {
    hold: opts.hold ?? false,
    /** What the next GETs answer with, in turn — a status, or `null` for a normal answer. */
    failGets: [] as Array<number | null>,
  };
  const pending: Held[] = [];
  const late: Array<() => void> = [];
  const log: Array<{ method: string; url: URL }> = [];

  /** A user, created a second after the last unless `at` says when (a tie, for one). */
  const add = (id: string, banned: boolean, at?: number) =>
    users.set(id, { banned, created: at ?? CREATED_FROM + 1000 * created++ });
  const locked = (id: string) => users.get(id)?.banned;

  const listed = (url: URL) => {
    const q = url.searchParams;
    const limit = Number(q.get('limit') ?? 10);
    const ids = q.getAll('user_id');
    let rows = [...users.entries()].sort((a, b) => b[1].created - a[1].created);
    if (ids.length > 0) rows = rows.filter(([id]) => ids.includes(id));
    const before = q.get('created_at_before');
    if (before !== null) rows = rows.filter(([, u]) => u.created < Number(before));
    if (q.get('banned') === 'true') rows = rows.filter(([, u]) => u.banned);
    return rows
      .slice(0, limit)
      .map(([id, u]) => ({ object: 'user', id, banned: u.banned, created_at: u.created }));
  };

  /** A POST's effect on Clerk; false when the user doesn't exist. */
  const apply = (url: URL) => {
    const [, , id, verb] = url.pathname.replace('/v1', '').split('/');
    const user = id === undefined ? undefined : users.get(id);
    if (!user) return false;
    user.banned = verb === 'ban';
    return true;
  };

  const answer = (method: string, url: URL, how: How = 'ok'): Promise<Response> => {
    if (method === 'GET') {
      if (typeof how === 'number') return Promise.resolve(new Response('no', { status: how }));
      return Promise.resolve(Response.json(listed(url)));
    }
    if (how === 'fail') return Promise.resolve(new Response('boom', { status: 503 }));
    if (how === 'late') {
      late.push(() => apply(url));
      return Promise.reject(new Error('The operation timed out'));
    }
    const found = apply(url);
    if (how === 'lost') return Promise.reject(new Error('The operation timed out'));
    if (how === 'die') return new Promise<Response>(() => {});
    return Promise.resolve(new Response('{}', { status: found ? 200 : 404 }));
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      log.push({ method, url });
      if (method === 'GET' && state.failGets.length > 0) {
        const status = state.failGets.shift();
        if (typeof status === 'number') return answer(method, url, status);
      }
      if (!state.hold) return answer(method, url);
      return new Promise<Response>((resolve, reject) => {
        const held: Held = {
          method,
          url,
          done: false,
          release: (how) => {
            if (held.done) return;
            held.done = true;
            answer(method, url, how).then(resolve, reject);
          },
        };
        pending.push(held);
      });
    }),
  );

  const settle = async () => {
    for (let i = 0; i < 8; i++) await turn();
  };
  /** Wait until `n` requests are held. */
  const held = async (n: number) => {
    for (let i = 0; i < 2000 && pending.length < n; i++) await turn();
    expect(pending.length).toBeGreaterThanOrEqual(n);
  };
  const posts = () => log.filter((r) => r.method === 'POST');
  const gets = () => log.filter((r) => r.method === 'GET');
  const applyLate = () => {
    for (const f of late.splice(0)) f();
  };
  return { users, add, locked, state, pending, late, log, posts, gets, settle, held, applyLate };
}
type Clerk = ReturnType<typeof fakeClerk>;

// ── The Convex side ─────────────────────────────────────────────────────────────────────────────

async function person(t: T, clerkUserId: string, status: Status) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId,
      displayName: 'x',
      username: clerkUserId,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: { ...NOTIFICATION_PREF_DEFAULTS },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member',
      status,
      createdAt: Date.UTC(2026, 0, 1),
    }),
  );
}

const setStatus = (t: T, id: Id<'profiles'>, status: Status) =>
  t.run((ctx) => ctx.db.patch(id, { status }));

async function pendingJobs(t: T) {
  return (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter(
    (j) => j.state.kind === 'pending',
  );
}

/**
 * Run every scheduled job — syncs, retries, the reconcile's own continuations — until none is left,
 * the fake answering at once; operator mail is collected, not sent. Returns the reconcile's last
 * step's outcome (when one ran) and the mail.
 */
async function drain(t: T, first?: RunOutcome) {
  let last = first;
  const alerts: Array<Record<string, unknown>> = [];
  for (let guard = 0; guard < 400; guard++) {
    const jobs = await pendingJobs(t);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      await t.run((ctx) => ctx.scheduler.cancel(job._id));
      const args = job.args[0] as never;
      if (job.name.includes('setBanned')) await t.action(internal.clerkAdmin.setBanned, args);
      else if (job.name.includes('clerkReconcile')) {
        last = await t.action(internal.clerkReconcile.run, args);
      } else if (job.name.includes('operatorAlerts')) alerts.push(job.args[0]);
    }
  }
  return { outcome: last, alerts };
}

/** One reconcile pass, run to its end with every repair it asked for. */
async function reconcile(t: T, args: { dryRun?: boolean } = {}) {
  const first = await t.action(internal.clerkReconcile.run, args);
  return drain(t, first);
}

const auditRows = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('moderationActions').take(10)).length);
const mirrorRows = (t: T) =>
  t.run((ctx) =>
    ctx.db
      .query('jobFailures')
      .withIndex('by_job_key', (q) => q.eq('job', 'clerkMirror'))
      .collect(),
  );

// ── The two gaps, reproduced, then closed ───────────────────────────────────────────────────────

describe('the gaps setBanned leaves, closed by one pass', () => {
  test.each([
    ['a lifted person stays locked; the pass unlocks', 'banned', 'active', false],
    ['a banned person is left unlocked; the pass locks', 'active', 'banned', true],
  ] as const)('a run that dies after Clerk answered: %s', async (_, first, second, want) => {
    const t = harness();
    const clerk = fakeClerk({ hold: true });
    clerk.add('u_p', first !== 'banned');
    const id = await person(t, 'u_p', first);
    // A's request goes out; then the status changes and B's goes out.
    void t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_p',
      banned: first === 'banned',
    });
    await clerk.held(1);
    await setStatus(t, id, second);
    const b = t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_p',
      banned: second === 'banned',
    });
    await clerk.held(2);
    // B lands and reads Convex: in step, done. A lands after it — and dies before its re-read.
    clerk.pending[1]?.release('ok');
    await b;
    clerk.pending[0]?.release('die');
    await clerk.settle();
    expect(clerk.locked('u_p'), 'the gap: Clerk holds the older value').toBe(!want);
    expect(await pendingJobs(t), 'and nothing is left to notice it').toHaveLength(0);

    clerk.state.hold = false;
    const { outcome } = await reconcile(t);
    expect(clerk.locked('u_p')).toBe(want);
    expect(outcome?.tally).toMatchObject(
      want ? { lockRepairs: 1, unlockRepairs: 0 } : { lockRepairs: 0, unlockRepairs: 1 },
    );
    expect(await auditRows(t)).toBe(0);
  });

  test.each([
    ['a lifted person stays locked; the pass unlocks', 'banned', 'active', false],
    ['a banned person is left unlocked; the pass locks', 'active', 'banned', true],
  ] as const)('a lost answer Clerk applies after its retry: %s', async (_, first, second, want) => {
    const t = harness();
    const clerk = fakeClerk({ hold: true });
    clerk.add('u_p', first !== 'banned');
    const id = await person(t, 'u_p', first);
    // A's answer is lost (a timeout); A reads Convex, which still wants it, and schedules a retry.
    const a = t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_p',
      banned: first === 'banned',
    });
    await clerk.held(1);
    clerk.pending[0]?.release('late');
    await a;
    const [retry] = await pendingJobs(t);
    expect(retry?.name).toContain('setBanned');
    // The status changes; its sync lands; then A's retry runs, reads afresh and lands too.
    await setStatus(t, id, second);
    const b = t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_p',
      banned: second === 'banned',
    });
    await clerk.held(2);
    clerk.pending[1]?.release('ok');
    await b;
    clerk.state.hold = false;
    await drain(t);
    expect(clerk.locked('u_p')).toBe(want);
    // Only now does Clerk apply A's original request.
    clerk.applyLate();
    expect(clerk.locked('u_p'), 'the gap: Clerk holds the older value').toBe(!want);
    expect(await pendingJobs(t)).toHaveLength(0);

    const { outcome } = await reconcile(t);
    expect(clerk.locked('u_p')).toBe(want);
    expect((outcome?.tally.lockRepairs ?? 0) + (outcome?.tally.unlockRepairs ?? 0)).toBe(1);
  });
});

// ── What a pass checks, and leaves alone ────────────────────────────────────────────────────────

describe('clerkReconcile.run — what it checks', () => {
  test('no-ops without CLERK_SECRET_KEY', async () => {
    const t = harness();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await t.action(internal.clerkReconcile.run, {});
    expect(out.state).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await pendingJobs(t)).toHaveLength(0);
  });

  test('a Clerk user with no profile, a person being deleted, a suspended and a banned person', async () => {
    const t = harness();
    const clerk = fakeClerk();
    for (const id of ['u_none', 'u_del', 'u_gone', 'u_susp', 'u_ban']) clerk.add(id, true);
    clerk.add('u_susp_free', false);
    await person(t, 'u_del', 'deleting');
    await person(t, 'u_gone', 'deleted');
    await person(t, 'u_susp', 'suspended');
    await person(t, 'u_susp_free', 'suspended');
    await person(t, 'u_ban', 'banned');
    const { outcome, alerts } = await reconcile(t);
    expect(outcome?.state).toBe('done');
    expect(outcome?.tally).toEqual({
      convexChecked: 1,
      clerkChecked: 5,
      lockRepairs: 0,
      unlockRepairs: 1,
      notInClerk: 0,
      noProfile: 1,
      beingDeleted: 2,
      overCap: 0,
      clerkReads: 2,
    });
    // Only the suspended person is unlocked; no one suspended is locked; the rest are untouched.
    expect(clerk.posts().map((r) => r.url.pathname)).toEqual(['/v1/users/u_susp/unban']);
    expect(clerk.locked('u_none')).toBe(true);
    expect(clerk.locked('u_del')).toBe(true);
    expect(clerk.locked('u_susp_free')).toBe(false);
    // One summary mail, counts only.
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).not.toMatch(/u_/);
    expect(await auditRows(t)).toBe(0);
  });

  test('a banned person Clerk has no user for is counted and left alone', async () => {
    const t = harness();
    const clerk = fakeClerk();
    await person(t, 'u_missing', 'banned');
    const { outcome } = await reconcile(t);
    expect(outcome?.tally).toMatchObject({ convexChecked: 1, notInClerk: 1, lockRepairs: 0 });
    expect(clerk.posts()).toHaveLength(0);
  });

  test('an in-step corpus repairs nothing, mails no one and leaves no row', async () => {
    const t = harness();
    const clerk = fakeClerk();
    // More banned people than Clerk's default page of ten: the read must ask for all of them.
    for (let i = 0; i < 30; i++) {
      clerk.add(`u_b${i}`, true);
      await person(t, `u_b${i}`, 'banned');
    }
    clerk.add('u_a', false);
    await person(t, 'u_a', 'active');
    const { outcome, alerts } = await reconcile(t);
    expect(outcome?.tally).toMatchObject({
      convexChecked: 30,
      clerkChecked: 30,
      notInClerk: 0,
      lockRepairs: 0,
      unlockRepairs: 0,
    });
    const byId = clerk.gets().find((r) => r.url.searchParams.has('user_id'));
    expect(byId?.url.searchParams.get('limit')).toBe(String(CLERK_PAGE));
    expect(clerk.posts()).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(await mirrorRows(t)).toHaveLength(0);
  });

  test('a dry run reads both sides and sends nothing, schedules nothing, writes nothing', async () => {
    const t = harness();
    const clerk = fakeClerk();
    clerk.add('u_lift', true);
    await person(t, 'u_lift', 'active');
    clerk.add('u_ban', false);
    await person(t, 'u_ban', 'banned');
    const out = await t.action(internal.clerkReconcile.run, { dryRun: true });
    expect(out).toMatchObject({ dryRun: true, state: 'done' });
    expect(out.tally).toMatchObject({ lockRepairs: 1, unlockRepairs: 1, clerkReads: 2 });
    expect(clerk.posts()).toHaveLength(0);
    expect(await pendingJobs(t)).toHaveLength(0);
    expect(await mirrorRows(t)).toHaveLength(0);
    expect(clerk.locked('u_lift')).toBe(true);
  });
});

// ── Pages, cursors, back-off ────────────────────────────────────────────────────────────────────

describe('clerkReconcile.run — bounded and polite', () => {
  test('both sides page past one page; an interrupted read resumes from its place; every account once', async () => {
    const t = harness();
    const clerk = fakeClerk();
    // 150 banned in Convex: 140 locked in Clerk, 10 not.
    for (let i = 0; i < 150; i++) {
      const id = `u_c${String(i).padStart(3, '0')}`;
      clerk.add(id, i >= 10);
      await person(t, id, 'banned');
    }
    // 400 more locked in Clerk, newer: 60 active in Convex, 340 with no profile. Clerk's list: 540.
    for (let i = 0; i < 400; i++) {
      const id = `u_k${String(i).padStart(3, '0')}`;
      clerk.add(id, true);
      if (i < 60) await person(t, id, 'active');
    }
    // Reads: the banned list's six pages, newest first — five reads a step, so the run continues
    // itself, and the unlocks its fourth page asked for land before the sixth is read — whose first
    // try fails; then the two Convex pages (one Clerk read by id each).
    clerk.state.failGets.push(null, null, null, null, null, 503);
    const first = await t.action(internal.clerkReconcile.run, {});
    expect(first.state).toBe('continued');
    const { outcome } = await drain(t, first);
    expect(outcome?.state).toBe('done');
    expect(outcome?.tally).toEqual({
      convexChecked: 150,
      clerkChecked: 540,
      lockRepairs: 10,
      unlockRepairs: 60,
      notInClerk: 0,
      noProfile: 340,
      beingDeleted: 0,
      overCap: 0,
      clerkReads: 7 + 2,
    });
    const lists = clerk.gets().filter((r) => r.url.searchParams.get('banned') === 'true');
    const places = lists.map((r) => r.url.searchParams.get('created_at_before'));
    // Seven list reads: each from the last page's last creation time; the failed one and its retry
    // from the same place.
    expect(places).toHaveLength(7);
    expect(places[0]).toBeNull();
    expect(new Set(places).size).toBe(6);
    expect(places[6]).toBe(places[5]);
    for (let i = 0; i < 150; i++)
      expect(clerk.locked(`u_c${String(i).padStart(3, '0')}`)).toBe(true);
    for (let i = 0; i < 60; i++)
      expect(clerk.locked(`u_k${String(i).padStart(3, '0')}`)).toBe(false);
    for (let i = 60; i < 400; i++)
      expect(clerk.locked(`u_k${String(i).padStart(3, '0')}`)).toBe(true);
    // One request a repair, no more.
    expect(clerk.posts()).toHaveLength(70);
  });

  test('the next page is found though the last user of this one was unlocked in between', async () => {
    const t = harness();
    const clerk = fakeClerk();
    // 101 locked in Clerk; the 100th newest — the first page's last — is active in Convex.
    for (let i = 0; i <= CLERK_PAGE; i++) clerk.add(`u_${i}`, true);
    await person(t, 'u_1', 'active');
    await person(t, 'u_0', 'active');
    // The second page's first try fails; the unlock of the first page's last user lands before the
    // retry reads.
    clerk.state.failGets.push(null, 503);
    const first = await t.action(internal.clerkReconcile.run, {});
    expect(first.state).toBe('retrying');
    const { outcome } = await drain(t, first);
    expect(outcome?.state).toBe('done');
    expect(clerk.locked('u_1')).toBe(false);
    expect(clerk.locked('u_0')).toBe(false);
    expect(outcome?.tally).toMatchObject({ clerkChecked: CLERK_PAGE + 1, unlockRepairs: 2 });
  });

  test('users created in the same millisecond across a page boundary are each read once', async () => {
    const t = harness();
    const clerk = fakeClerk();
    // 150 locked, no profile; the 21 from the 41st to the 61st oldest share one creation time,
    // which the first page (the 100 newest) cuts through.
    const tie = CREATED_FROM + 1000 * 50;
    for (let i = 0; i < 150; i++) clerk.add(`u_${i}`, true, i >= 40 && i <= 60 ? tie : undefined);
    const { outcome } = await reconcile(t, { dryRun: true });
    expect(outcome?.tally).toMatchObject({ clerkChecked: 150, noProfile: 150, clerkReads: 2 });
    expect(clerk.gets()[1]?.url.searchParams.get('created_at_before')).toBe(String(tie + 1));
  });

  test('more than a page of users created in one millisecond stops the run and pages, never loops', async () => {
    const t = harness();
    const clerk = fakeClerk();
    for (let i = 0; i <= CLERK_PAGE; i++) clerk.add(`u_${i}`, true, CREATED_FROM);
    const out = await t.action(internal.clerkReconcile.run, {});
    expect(out.state).toBe('stopped');
    expect(clerk.gets()).toHaveLength(2);
    const [page] = (await pendingJobs(t)).filter((j) => j.name.includes('operatorAlerts'));
    expect(JSON.stringify(page?.args[0])).toMatch(/share one creation time/);
  });

  test.each([429, 503, 408])(
    'a %i is retried on the sync’s schedule, from the same position',
    async (status) => {
      const t = harness();
      const clerk = fakeClerk();
      clerk.add('u_lift', true);
      await person(t, 'u_lift', 'active');
      clerk.state.failGets.push(status);
      const before = Date.now();
      const out = await t.action(internal.clerkReconcile.run, {});
      expect(out.state).toBe('retrying');
      const [job] = await pendingJobs(t);
      expect(job?.name).toContain('clerkReconcile');
      expect(job?.args[0]).toMatchObject({ side: 'clerk', cursor: null, attempt: 1 });
      expect((job?.scheduledTime ?? 0) - before).toBeGreaterThanOrEqual(30_000);
      expect(clerk.posts()).toHaveLength(0);
      const { outcome } = await drain(t, out);
      expect(outcome?.state).toBe('done');
      expect(clerk.locked('u_lift')).toBe(false);
    },
  );

  test('a hung read times out at the shared limit and is retried', async () => {
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const hang = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => hang.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation timed out')),
            );
            queueMicrotask(() => hang.abort());
          }),
      ),
    );
    const out = await t.action(internal.clerkReconcile.run, {});
    expect(timeout).toHaveBeenCalledWith(CLERK_TIMEOUT_MS);
    expect(out.state).toBe('retrying');
    const [job] = await pendingJobs(t);
    expect(job?.args[0]).toMatchObject({ attempt: 1 });
  });

  test('a spent budget pages the operator, and the run is counted unfinished until one finishes', async () => {
    const t = harness();
    const clerk = fakeClerk();
    clerk.add('u_lift', true);
    await person(t, 'u_lift', 'active');
    clerk.state.failGets.push(503);
    // attempt 3 == the last slot in the retry schedule, so this read has no retries left.
    const out = await t.action(internal.clerkReconcile.run, { side: 'clerk', attempt: 3 });
    expect(out.state).toBe('stopped');
    const jobs = await pendingJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toContain('operatorAlerts');
    expect(JSON.stringify(jobs[0]?.args[0])).toMatch(/daily ban-lock check/);
    expect(JSON.stringify(jobs[0]?.args[0])).toMatch(/changed nothing/);
    expect((await mirrorRows(t)).map((r) => [r.key, r.errorClass])).toEqual([
      [RUN_KEY, 'Unfinished'],
    ]);
    await t.run((ctx) => ctx.scheduler.cancel(jobs[0]?._id as never));
    await reconcile(t);
    expect((await mirrorRows(t)).map((r) => r.errorClass)).toEqual(['UnlockRepaired']);
  });

  test('a run asks for at most its cap of repairs; the rest are counted, mailed and left for the next', async () => {
    const t = harness();
    const clerk = fakeClerk();
    const n = MAX_REPAIRS_PER_RUN + 5;
    for (let i = 0; i < n; i++) {
      clerk.add(`u_${i}`, true);
      await person(t, `u_${i}`, 'active');
    }
    const admin = await person(t, 'u_admin', 'active');
    await t.run((ctx) => ctx.db.patch(admin, { role: 'admin' }));
    const first = await t.action(internal.clerkReconcile.run, {});
    const repairs = (await pendingJobs(t)).filter((j) => j.name.includes('setBanned'));
    expect(repairs.length).toBeLessThanOrEqual(MAX_REPAIRS_PER_RUN);
    const { outcome, alerts } = await drain(t, first);
    expect(outcome?.tally).toMatchObject({ unlockRepairs: MAX_REPAIRS_PER_RUN, overCap: 5 });
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).toMatch(/5 more were out of step/);
    expect((await mirrorRows(t)).find((r) => r.key === RUN_KEY)?.errorClass).toBe('OverRepairCap');
    // The run's own row reaches Machinery's capped read, though the run wrote a cap's worth of repairs.
    const health = await t.withIdentity({ subject: 'u_admin' }).query(api.recurringJobs.health, {});
    const job = health.jobs.find((j) => j.job === 'reconcile clerk ban locks');
    expect(job?.capped).toBe(true);
    expect(job?.errorClasses).toMatchObject({ OverRepairCap: 1 });
    const next = await reconcile(t);
    expect(next.outcome?.tally).toMatchObject({ unlockRepairs: 5, overCap: 0 });
    expect((await mirrorRows(t)).find((r) => r.key === RUN_KEY)).toBeUndefined();
  });

  test('repairs found late in a run — after a back-off — are spaced one after another, never sent at once', async () => {
    const t = harness();
    const clerk = fakeClerk();
    for (let i = 0; i < 150; i++) {
      clerk.add(`u_${i}`, true);
      await person(t, `u_${i}`, 'active');
    }
    // A run that started ten minutes ago, past its slots from the start; its second page fails once.
    clerk.state.failGets.push(null, 503);
    const first = await t.action(internal.clerkReconcile.run, {
      runId: Date.now() - 10 * 60_000,
      side: 'clerk',
    });
    expect(first.state).toBe('retrying');
    const [retry] = (await pendingJobs(t)).filter((j) => j.name.includes('clerkReconcile'));
    await t.run((ctx) => ctx.scheduler.cancel(retry?._id as never));
    const second = await t.action(internal.clerkReconcile.run, retry?.args[0] as never);
    expect(second.state).toBe('done');
    const times = (await pendingJobs(t))
      .filter((j) => j.name.includes('setBanned'))
      .map((j) => j.scheduledTime)
      .sort((a, b) => a - b);
    expect(times).toHaveLength(150);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(REPAIR_SPACING_MS);
    }
  });

  test('a page Clerk answers full is not the last, though an entry on it could not be read', async () => {
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const full = [
      { object: 'user' },
      ...Array.from({ length: CLERK_PAGE - 1 }, (_, i) => ({
        id: `u_${i}`,
        banned: true,
        created_at: CREATED_FROM - 1000 * i,
      })),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(full))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    const out = await t.action(internal.clerkReconcile.run, { side: 'clerk', dryRun: true });
    expect(out.state).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.tally).toMatchObject({ clerkChecked: CLERK_PAGE - 1, noProfile: CLERK_PAGE - 1 });
  });

  test('a run that gave up after asking for repairs says they still run', async () => {
    const t = harness();
    const clerk = fakeClerk();
    for (let i = 0; i < CLERK_PAGE + 1; i++) {
      clerk.add(`u_${i}`, true);
      await person(t, `u_${i}`, 'active');
    }
    // The first page answers; the second is refused for good (a revoked key, say).
    clerk.state.failGets.push(null, 401);
    const out = await t.action(internal.clerkReconcile.run, { side: 'clerk' });
    expect(out.state).toBe('stopped');
    const [page] = (await pendingJobs(t)).filter((j) => j.name.includes('operatorAlerts'));
    expect(JSON.stringify(page?.args[0])).toMatch(
      new RegExp(`The ${CLERK_PAGE} repair\\(s\\) it had already asked for still run`),
    );
  });

  test('a run that only reached its read limit mails that, not that it found anyone out of step', async () => {
    const t = harness();
    fakeClerk();
    const out = await t.action(internal.clerkReconcile.run, {
      tally: { ...EMPTY_TALLY, clerkReads: MAX_READS_PER_RUN },
    });
    expect(out.state).toBe('capped');
    const { alerts } = await drain(t, out);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      subject: 'Clerk sign-in locks: the daily check stopped at its limit',
    });
    expect(JSON.stringify(alerts[0])).not.toMatch(/out of step|A repair means/);
    expect((await mirrorRows(t)).map((r) => [r.key, r.errorClass])).toEqual([[RUN_KEY, 'Capped']]);
  });

  test('a Convex failure stops the run, counted unfinished, its side in the log and no id', async () => {
    const t = harness();
    fakeClerk();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      t.action(internal.clerkReconcile.run, { side: 'convex', cursor: 'not a cursor' }),
    ).rejects.toThrow();
    expect((await mirrorRows(t)).map((r) => [r.key, r.errorClass])).toEqual([
      [RUN_KEY, 'Unfinished'],
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/stopped on the convex side/));
    expect(await pendingJobs(t)).toHaveLength(0);
  });
});

// ── What it reports ─────────────────────────────────────────────────────────────────────────────

describe('clerkReconcile — what it reports', () => {
  test('each repair is a row the Machinery read counts by direction — no names or ids — kept a week', async () => {
    const t = harness();
    const clerk = fakeClerk();
    clerk.add('u_lift', true);
    const lifted = await person(t, 'u_lift', 'active');
    clerk.add('u_ban', false);
    await person(t, 'u_ban', 'banned');
    const admin = await person(t, 'u_admin', 'active');
    await t.run((ctx) => ctx.db.patch(admin, { role: 'admin' }));
    clerk.add('u_admin', false);
    // A repair row from over a week ago, forgotten by this run.
    await t.run((ctx) =>
      ctx.db.insert('jobFailures', {
        job: 'clerkMirror',
        key: '1.0',
        attempts: 1,
        errorClass: 'LockRepaired',
        firstFailedAt: Date.now() - REPAIR_RETENTION_MS - 60_000,
        lastFailedAt: Date.now() - REPAIR_RETENTION_MS - 60_000,
      }),
    );
    const { alerts } = await reconcile(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ subject: 'Clerk sign-in locks: 2 repaired' });
    const health = await t.withIdentity({ subject: 'u_admin' }).query(api.recurringJobs.health, {});
    const job = health.jobs.find((j) => j.job === 'reconcile clerk ban locks');
    expect(job).toMatchObject({
      failing: 2,
      parked: 0,
      errorClasses: { LockRepaired: 1, UnlockRepaired: 1 },
    });
    for (const text of [
      JSON.stringify(health),
      JSON.stringify(alerts),
      JSON.stringify(await mirrorRows(t)),
    ]) {
      expect(text).not.toMatch(/u_lift|u_ban/);
      expect(text).not.toContain(lifted);
    }
    // A second pass repairs nothing and mails no one; the week's rows stay.
    const second = await reconcile(t);
    expect(second.outcome?.tally).toMatchObject({ lockRepairs: 0, unlockRepairs: 0 });
    expect(second.alerts).toHaveLength(0);
    expect(await mirrorRows(t)).toHaveLength(2);
    expect(await auditRows(t)).toBe(0);
  });
});

// ── Racing a sync in flight ─────────────────────────────────────────────────────────────────────

describe('clerkReconcile — racing a sync in flight, answered in either order', () => {
  test.each([
    ['the sync lands before the stale read answers', 'sync-first'],
    ['the stale read answers before the sync lands', 'read-first'],
  ] as const)('Convex read banned, then lifted: the pass never re-locks — %s', async (_, order) => {
    const t = harness();
    const clerk = fakeClerk({ hold: true });
    clerk.add('u_p', false); // the gap: banned in Convex, unlocked in Clerk
    const id = await person(t, 'u_p', 'banned');
    // The pass reads Clerk's banned list (no one), then Convex's page (banned), and its read of
    // those users in Clerk goes out.
    const pass = t.action(internal.clerkReconcile.run, {});
    await clerk.held(1);
    clerk.pending[0]?.release();
    await clerk.held(2);
    // Now the person is lifted and that sync's unlock goes out.
    await setStatus(t, id, 'active');
    const sync = t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_p', banned: false });
    await clerk.held(3);
    if (order === 'sync-first') {
      clerk.pending[2]?.release();
      await sync;
      clerk.pending[1]?.release();
    } else {
      clerk.pending[1]?.release();
    }
    // The pass found Clerk unlocked against its banned read and asks for a lock.
    let passed = false;
    void pass.then(() => {
      passed = true;
    });
    for (let i = 0; i < 2000 && !passed; i++) {
      await turn();
      for (const r of clerk.pending.filter((r) => !r.done && r.method === 'GET')) r.release();
    }
    const out = await pass;
    expect(out.tally.lockRepairs).toBe(1);
    // … whose run reads Convex first: it sends the unlock, never a lock.
    clerk.state.hold = false;
    for (const r of clerk.pending) r.release();
    await drain(t, out);
    await sync;
    expect(clerk.locked('u_p')).toBe(false);
    expect(clerk.posts().map((r) => r.url.pathname.endsWith('/ban'))).not.toContain(true);
  });

  test.each([
    ['the repair lands first', 'repair-first'],
    ['the newer sync lands first', 'sync-first'],
  ] as const)(
    'Clerk read locked, Convex active, then banned: the pass never unlocks — %s',
    async (_, order) => {
      const t = harness();
      const clerk = fakeClerk({ hold: true });
      clerk.add('u_p', true); // the gap: active in Convex, locked in Clerk
      const id = await person(t, 'u_p', 'active');
      const pass = t.action(internal.clerkReconcile.run, {});
      await clerk.held(1);
      clerk.pending[0]?.release();
      // The pass asked Convex (active) and nominated an unlock; it has ended.
      const out = await pass;
      expect(out.tally.unlockRepairs).toBe(1);
      // Now the person is banned; that sync's ban goes out and is held.
      await setStatus(t, id, 'banned');
      const sync = t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_p', banned: true });
      await clerk.held(2);
      // The repair runs: it reads Convex (banned) and sends a ban, not the unlock it was asked for.
      const [job] = (await pendingJobs(t)).filter((j) => j.name.includes('setBanned'));
      await t.run((ctx) => ctx.scheduler.cancel(job?._id as never));
      const repair = t.action(internal.clerkAdmin.setBanned, job?.args[0] as never);
      await clerk.held(3);
      expect(clerk.pending[2]?.url.pathname).toBe('/v1/users/u_p/ban');
      const [first, second] = order === 'repair-first' ? [2, 1] : [1, 2];
      clerk.pending[first]?.release();
      clerk.pending[second]?.release();
      await Promise.all([sync, repair]);
      expect(clerk.locked('u_p')).toBe(true);
      expect(clerk.posts().some((r) => r.url.pathname.endsWith('/unban'))).toBe(false);
    },
  );

  test('a repair for someone whose profile is gone, or who is now being deleted, sends nothing', async () => {
    const t = harness();
    const clerk = fakeClerk();
    clerk.add('u_none', true);
    clerk.add('u_del', true);
    await person(t, 'u_del', 'deleting');
    await t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_none',
      banned: false,
      repair: true,
    });
    await t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_del',
      banned: false,
      repair: true,
    });
    expect(clerk.posts()).toHaveLength(0);
    expect(await pendingJobs(t)).toHaveLength(0);
  });

  test('a repair’s retry stays a repair', async () => {
    const t = harness();
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );
    await person(t, 'u_p', 'active');
    await t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_p',
      banned: false,
      repair: true,
    });
    const [job] = await pendingJobs(t);
    expect(job?.args[0]).toMatchObject({ clerkUserId: 'u_p', attempt: 1, repair: true });
  });
});

// ── Over any history (model) ────────────────────────────────────────────────────────────────────

describe('clerkReconcile — over any history (model)', () => {
  test('after any status changes, orderings, lost and late answers and dead runs, one pass puts Clerk where Convex is; requests are bounded; no audit row; a second pass repairs nothing', async () => {
    const PEOPLE = ['u_m0', 'u_m1'] as const;
    type Op =
      | { kind: 'set'; who: number; status: 'active' | 'suspended' | 'banned' }
      | { kind: 'answer'; pick: number; how: 'ok' | 'fail' | 'lost' | 'late' | 'die' }
      | { kind: 'applyLate' };
    const op: fc.Arbitrary<Op> = fc.oneof(
      // Status changes and answers weighted up: a gap needs two syncs in flight for one person and
      // the earlier one landing last, dead or late.
      {
        weight: 3,
        arbitrary: fc.record({
          kind: fc.constant('set' as const),
          who: fc.nat(PEOPLE.length - 1),
          status: fc.constantFrom('active' as const, 'suspended' as const, 'banned' as const),
        }),
      },
      {
        weight: 4,
        arbitrary: fc.record({
          kind: fc.constant('answer' as const),
          pick: fc.nat(7),
          how: fc.constantFrom(
            'ok' as const,
            'fail' as const,
            'lost' as const,
            'late' as const,
            'die' as const,
          ),
        }),
      },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('applyLate' as const) }) },
    );
    /** Histories that left Clerk out of step before the pass — so the property is never vacuous. */
    let gaps = 0;
    const run = fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 12 }), async (ops) => {
      const t = harness();
      const clerk: Clerk = fakeClerk({ hold: true });
      const ids: Id<'profiles'>[] = [];
      for (const who of PEOPLE) {
        clerk.add(who, false);
        ids.push(await person(t, who, 'active'));
      }
      // Two Clerk users the pass must leave alone: no profile, and being deleted.
      clerk.add('u_none', true);
      clerk.add('u_del', true);
      await person(t, 'u_del', 'deleting');

      const open = () => clerk.pending.filter((r) => !r.done);
      // A run awaits one request at a time, so each request released with `die` strands one run.
      let started = 0;
      let ended = 0;
      let died = 0;
      for (const o of ops) {
        if (o.kind === 'set') {
          await setStatus(t, ids[o.who] as Id<'profiles'>, o.status);
          started++;
          void t
            .action(internal.clerkAdmin.setBanned, {
              clerkUserId: PEOPLE[o.who] as string,
              banned: o.status === 'banned',
            })
            .finally(() => {
              ended++;
            });
        } else if (o.kind === 'answer') {
          const waiting = open();
          const r = waiting[o.pick % Math.max(1, waiting.length)];
          if (r) {
            if (o.how === 'die') died++;
            r.release(o.how);
          }
        } else {
          clerk.applyLate();
        }
        await clerk.settle();
      }
      // Everything still out answers; every retry runs; then the late answers land — after them.
      clerk.state.hold = false;
      for (const r of open()) r.release('ok');
      for (let i = 0; i < 4000 && ended < started - died; i++) await turn();
      expect(ended).toBe(started - died);
      await drain(t);
      clerk.applyLate();

      const posts = clerk.posts().length;
      const gets = clerk.gets().length;
      const { outcome } = await reconcile(t);
      const statuses = await t.run(async (ctx) =>
        Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.status)),
      );
      PEOPLE.forEach((who, i) => {
        expect(clerk.locked(who), who).toBe(statuses[i] === 'banned');
      });
      expect(clerk.locked('u_none')).toBe(true);
      expect(clerk.locked('u_del')).toBe(true);
      // The bound: one read by id for the (single) page of banned profiles, if any, plus one page of
      // Clerk's banned list; at most SETTLE_ROUNDS requests per repair.
      const repairs = (outcome?.tally.lockRepairs ?? 0) + (outcome?.tally.unlockRepairs ?? 0);
      expect(clerk.gets().length - gets).toBeLessThanOrEqual(2);
      expect(clerk.posts().length - posts).toBeLessThanOrEqual(SETTLE_ROUNDS * repairs);
      expect(repairs).toBeLessThanOrEqual(PEOPLE.length);
      if (repairs > 0) gaps++;
      for (const r of clerk.posts().slice(posts))
        expect(r.url.pathname).not.toMatch(/u_none|u_del/);
      expect(await auditRows(t)).toBe(0);
      // A second pass finds nothing to repair, and sends nothing.
      const after = clerk.posts().length;
      const second = await reconcile(t);
      expect(second.outcome?.tally).toMatchObject({ lockRepairs: 0, unlockRepairs: 0 });
      expect(clerk.posts().length).toBe(after);
    });
    // Pinned seeds, so a failure replays — chosen because their histories leave Clerk out of step
    // (three of the eleven) — then a few runs on a fresh seed.
    await fc.assert(run, { seed: 5, numRuns: 6 });
    await fc.assert(run, { seed: 7, numRuns: 5 });
    expect(gaps, 'the pinned histories reproduce a gap').toBeGreaterThanOrEqual(3);
    await fc.assert(run, { numRuns: 2 });
  });
});
