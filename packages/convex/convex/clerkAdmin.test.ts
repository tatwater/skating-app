/**
 * Clerk lock reconciliation (D37, hardened 2026-07-24). The Convex `status` patch commits before this
 * action runs, so a silent Clerk failure splits the two systems — worst case a reinstated user stays
 * locked out of sign-in. These cover: transient failures retry, permanent ones escalate immediately,
 * and a spent retry budget pages the operator instead of vanishing into a log line.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { SETTLE_ROUNDS } from './clerkAdmin';
import { NOTIFICATION_PREF_DEFAULTS } from './lib/enums';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** The scheduler rows this action queued, newest last. */
async function scheduled(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
}

/** A person whose status `lockWanted` reads. */
async function person(
  t: ReturnType<typeof convexTest>,
  status: 'active' | 'banned',
  clerkUserId = 'u_mirror',
) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId,
      displayName: 'x',
      username: 'x',
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('clerkAdmin.setBanned', () => {
  test('no-ops without CLERK_SECRET_KEY (the Convex gate is the real boundary)', async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_1', banned: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await scheduled(t)).toHaveLength(0);
  });

  test('a successful call schedules nothing', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );

    await t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_1', banned: false });

    expect(await scheduled(t)).toHaveLength(0);
  });

  test('a transient failure (5xx) schedules a retry rather than giving up', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );

    await t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_1', banned: false });

    const rows = await scheduled(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toContain('clerkAdmin');
    expect(rows[0]?.args[0]).toMatchObject({ clerkUserId: 'u_1', banned: false, attempt: 1 });
  });

  test('a spent retry budget alerts the operator to unlock the user by hand', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );

    // attempt 3 == the last slot in RETRY_DELAYS_MS, so this run has no retries left.
    await t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_1',
      banned: false,
      attempt: 3,
    });

    const rows = await scheduled(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toContain('operatorAlerts');
    expect(rows[0]?.args[0]).toMatchObject({ deepLinkPath: '/admin/users' });
    // The unban direction has to say "the user is locked out", not just "something failed".
    expect(JSON.stringify(rows[0]?.args[0])).toMatch(/locked out/);
  });

  test('a permanent failure (4xx) escalates immediately instead of burning the backoff', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no such user', { status: 404 })),
    );

    await t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'gone', banned: true });

    const rows = await scheduled(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toContain('operatorAlerts');
  });

  test('a thrown fetch (network blip) retries', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    await t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_1', banned: true });

    const rows = await scheduled(t);
    expect(rows[0]?.args[0]).toMatchObject({ attempt: 1 });
  });

  test('a retry sends what Convex says now, not what it was scheduled with — a ban retry after a lift unlocks', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const fetchMock = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await person(t, 'active', 'u_lifted');
    // A ban's retry, still in flight after the person was lifted.
    await t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_lifted',
      banned: true,
      attempt: 1,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/users\/u_lifted\/unban$/);
  });
});

// ── Overlapping syncs: Clerk ends where Convex is ───────────────────────────────────────────────

/**
 * A fake Clerk whose requests answer only when released, in any order: a request is applied when it
 * is released (Clerk's lock becomes its verb), then its answer — success, or the failure status it is
 * released with, which leaves the lock alone — reaches the action. No real call leaves the test.
 */
function fakeClerk() {
  const pending: Array<{ banned: boolean; done: boolean; release: (failWith?: number) => void }> =
    [];
  const state = { locked: null as boolean | null, sends: 0 };
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          state.sends++;
          const banned = String(url).endsWith('/ban');
          const request = {
            banned,
            done: false,
            release: (failWith?: number) => {
              if (request.done) return;
              request.done = true;
              if (failWith !== undefined) {
                resolve(new Response('boom', { status: failWith }));
                return;
              }
              state.locked = banned;
              resolve(new Response('{}', { status: 200 }));
            },
          };
          pending.push(request);
        }),
    ),
  );
  /** Let the actions run up to their next request (or their end). */
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Wait until `n` requests have been sent. */
  const sent = async (n: number) => {
    for (let i = 0; i < 400 && pending.length < n; i++) await new Promise((r) => setTimeout(r, 5));
    expect(pending.length).toBeGreaterThanOrEqual(n);
  };
  return { pending, state, settle, sent };
}

const setStatus = (
  t: ReturnType<typeof convexTest>,
  id: Id<'profiles'>,
  status: 'active' | 'banned',
) => t.run((ctx) => ctx.db.patch(id, { status }));

describe('clerkAdmin.setBanned — overlapping syncs converge on Convex', () => {
  test.each([
    ['a ban, then a lift, answered in reverse: Clerk ends unlocked', 'banned', 'active', false],
    ['a lift, then a ban, answered in reverse: Clerk ends locked', 'active', 'banned', true],
  ] as const)('%s', async (_, first, second, locked) => {
    const t = convexTest(schema, modules);
    const clerk = fakeClerk();
    const id = await person(t, first);
    const a = t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_mirror',
      banned: first === 'banned',
    });
    await clerk.sent(1);
    await setStatus(t, id, second);
    const b = t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_mirror',
      banned: second === 'banned',
    });
    await clerk.sent(2);
    expect(clerk.pending.map((r) => r.banned)).toEqual([first === 'banned', second === 'banned']);
    // The later request answers first; the earlier one lands on Clerk after it.
    clerk.pending[1]?.release();
    clerk.pending[0]?.release();
    // Whatever either sends next, answer it, until both have ended.
    let done = false;
    void Promise.all([a, b]).then(() => {
      done = true;
    });
    for (let i = 2; !done && i < 40; i++) {
      await clerk.settle();
      for (const r of clerk.pending.slice(2)) r.release();
    }
    await Promise.all([a, b]);
    expect(clerk.state.locked).toBe(locked);
  });

  test('a permanent failure whose wish moved sends the new wish instead of paging', async () => {
    const t = convexTest(schema, modules);
    const clerk = fakeClerk();
    const id = await person(t, 'banned');
    const a = t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_mirror', banned: true });
    await clerk.sent(1);
    // Lifted while the ban was out; the ban then fails for good.
    await setStatus(t, id, 'active');
    clerk.pending[0]?.release(422);
    await clerk.sent(2);
    expect(clerk.pending[1]?.banned).toBe(false);
    clerk.pending[1]?.release();
    await a;
    expect(clerk.state.locked).toBe(false);
    expect(await scheduled(t)).toHaveLength(0);
  });

  test.each([
    ['retries with the last wish', 0, 'clerkAdmin'],
    // attempt 3 == the last slot in RETRY_DELAYS_MS, so this run has no retries left.
    ['past its budget, pages the operator', 3, 'operatorAlerts'],
  ])('a wish still moving after every round %s', async (_, attempt, to) => {
    const t = convexTest(schema, modules);
    const clerk = fakeClerk();
    const id = await person(t, 'active');
    const a = t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_mirror',
      banned: false,
      attempt,
    });
    // Every answer finds Convex moved again.
    for (let n = 1; n <= SETTLE_ROUNDS; n++) {
      await clerk.sent(n);
      await setStatus(t, id, n % 2 === 1 ? 'banned' : 'active');
      clerk.pending[n - 1]?.release();
    }
    await a;
    expect(clerk.state.sends).toBe(SETTLE_ROUNDS);
    const rows = await scheduled(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toContain(to);
    const last = SETTLE_ROUNDS % 2 === 1; // the wish the last read found, never sent
    if (to === 'clerkAdmin') {
      expect(rows[0]?.args[0]).toMatchObject({ banned: last, attempt: attempt + 1 });
    } else {
      expect(JSON.stringify(rows[0]?.args[0])).toMatch(/kept changing/);
    }
  });
});

describe('clerkAdmin.setBanned — a person being deleted', () => {
  test('a sync for someone deleted, or being deleted, sends nothing and pages no one', async () => {
    const t = convexTest(schema, modules);
    const clerk = fakeClerk();
    const id = await person(t, 'banned');
    await t.run((ctx) => ctx.db.patch(id, { status: 'deleted' }));
    await t.action(internal.clerkAdmin.setBanned, { clerkUserId: 'u_mirror', banned: true });
    expect(clerk.state.sends).toBe(0);
    expect(await scheduled(t)).toHaveLength(0);
  });
});

describe('clerkAdmin.setBanned — over any interleaving (model)', () => {
  test('once every request has answered and no retry is pending, Clerk says what Convex says; sends are bounded', async () => {
    type Op = { kind: 'set'; banned: boolean } | { kind: 'answer'; pick: number; fail: boolean };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant('set' as const), banned: fc.boolean() }),
      fc.record({ kind: fc.constant('answer' as const), pick: fc.nat(5), fail: fc.boolean() }),
    );
    const run = fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 6 }), async (ops) => {
      const t = convexTest(schema, modules);
      const clerk = fakeClerk();
      const id = await person(t, 'active');
      const actions: Array<Promise<unknown>> = [];
      const start = (banned: boolean, attempt?: number) =>
        actions.push(
          t.action(internal.clerkAdmin.setBanned, {
            clerkUserId: 'u_mirror',
            banned,
            ...(attempt !== undefined ? { attempt } : {}),
          }),
        );
      const open = () => clerk.pending.filter((r) => !r.done);
      for (const o of ops) {
        if (o.kind === 'set') {
          // A status write, and the sync it schedules.
          await setStatus(t, id, o.banned ? 'banned' : 'active');
          start(o.banned);
        } else {
          const waiting = open();
          if (waiting.length > 0)
            waiting[o.pick % waiting.length]?.release(o.fail ? 503 : undefined);
        }
        await clerk.settle();
      }
      // Drain: answer everything, run every retry the failures scheduled, until nothing is left.
      for (let guard = 0; guard < 50; guard++) {
        await clerk.settle();
        for (const r of open()) r.release();
        await clerk.settle();
        const retries = await t.run(async (ctx) =>
          (await ctx.db.system.query('_scheduled_functions').collect()).filter(
            (j) => j.state.kind === 'pending' && j.name.includes('setBanned'),
          ),
        );
        for (const job of retries) {
          await t.run((ctx) => ctx.scheduler.cancel(job._id));
          const args = job.args[0] as { banned: boolean; attempt?: number };
          start(args.banned, args.attempt);
        }
        if (retries.length === 0 && open().length === 0) break;
      }
      await Promise.all(actions);
      const status = (await t.run((ctx) => ctx.db.get(id)))?.status;
      // Nothing sent at all only if nothing was ever asked of Clerk.
      if (clerk.state.locked !== null) expect(clerk.state.locked).toBe(status === 'banned');
      else expect(actions.length).toBe(0);
      expect(clerk.state.sends).toBeLessThanOrEqual(SETTLE_ROUNDS * actions.length);
    });
    // Pinned seeds, so a failure replays; then one run on a fresh seed.
    for (const seed of [20261116, 8]) await fc.assert(run, { seed, numRuns: 6 });
    await fc.assert(run, { numRuns: 3 });
  });
});
