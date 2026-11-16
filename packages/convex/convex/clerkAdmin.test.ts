/**
 * Clerk lock reconciliation (D37, hardened 2026-07-24). The Convex `status` patch commits before this
 * action runs, so a silent Clerk failure splits the two systems — worst case a reinstated user stays
 * locked out of sign-in. These cover: transient failures retry, permanent ones escalate immediately,
 * and a spent retry budget pages the operator instead of vanishing into a log line.
 */
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** The scheduler rows this action queued, newest last. */
async function scheduled(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
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
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'u_lifted',
        displayName: 'x',
        username: 'x',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyAnswered: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: false,
          greatReportNearby: false,
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member',
        status: 'active',
        createdAt: Date.UTC(2026, 0, 1),
      }),
    );
    // A ban's retry, still in flight after the person was lifted.
    await t.action(internal.clerkAdmin.setBanned, {
      clerkUserId: 'u_lifted',
      banned: true,
      attempt: 1,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/users\/u_lifted\/unban$/);
  });
});
