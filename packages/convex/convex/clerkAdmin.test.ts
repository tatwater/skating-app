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
});
