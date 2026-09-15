import { convexTest } from 'convex-test';
import { Webhook } from 'standardwebhooks';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from '../_generated/api';
import schema from '../schema';
import { primaryEmailOf, reduceEvent } from './clerkWebhook';

const modules = import.meta.glob('../**/*.*s');

// A real Standard Webhooks secret (`whsec_` + base64). The library signs and verifies with the same
// key, so the fixtures below are what Clerk would actually send, not a hand-rolled approximation.
const SECRET = `whsec_${btoa('a-32-byte-test-secret-for-clerk!')}`;

/** Sign `payload` the way Svix does and return the headers Clerk sets on the request. */
function signed(payload: unknown, secret = SECRET, at = new Date()) {
  const body = JSON.stringify(payload);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const signature = new Webhook(secret).sign(id, at, body);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(Math.floor(at.getTime() / 1000)),
      'svix-signature': signature,
    },
  };
}

function userEvent(
  type: 'user.created' | 'user.updated' | 'user.deleted',
  data: Record<string, unknown>,
) {
  return { type, object: 'event', data };
}

const ADA = {
  id: 'clerk_ada',
  image_url: 'https://img/ada-2',
  primary_email_address_id: 'e2',
  email_addresses: [
    { id: 'e1', email_address: 'old@example.test' },
    { id: 'e2', email_address: 'new@example.test' },
  ],
};

async function seedAda(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'clerk_ada',
      displayName: 'Ada',
      username: 'ada',
      email: 'old@example.test',
      profileImageUrl: 'https://img/ada-1',
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
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
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('reduceEvent / primaryEmailOf (the shape, unsigned)', () => {
  test('a user event reduces to id, primary email, avatar; an account with no address reads null', () => {
    expect(reduceEvent(userEvent('user.updated', ADA))).toEqual({
      type: 'user.updated',
      clerkUserId: 'clerk_ada',
      email: 'new@example.test',
      profileImageUrl: 'https://img/ada-2',
    });
    expect(reduceEvent(userEvent('user.created', { id: 'u', email_addresses: [] }))).toMatchObject({
      type: 'user.created',
      email: null,
      profileImageUrl: null,
    });
    expect(
      primaryEmailOf({ primary_email_address_id: 'gone', email_addresses: ADA.email_addresses }),
    ).toBe('old@example.test');
  });

  test('a user event without an id is a 400; a deletion and an unknown type are acknowledged', () => {
    expect(() => reduceEvent(userEvent('user.updated', {}))).toThrow(/without a user id/);
    expect(reduceEvent(userEvent('user.deleted', { id: 'u', deleted: true }))).toEqual({
      type: 'user.deleted',
      clerkUserId: 'u',
    });
    expect(reduceEvent({ type: 'session.created', data: {} })).toEqual({
      type: 'ignored',
      raw: 'session.created',
    });
    expect(reduceEvent(null)).toEqual({ type: 'ignored', raw: '' });
  });
});

describe('POST /clerk-webhook', () => {
  test('a signed user.updated moves the email and avatar mirrors, and a replay changes nothing', async () => {
    const t = convexTest(schema, modules);
    const id = await seedAda(t);
    const { body, headers } = signed(userEvent('user.updated', ADA));
    const res = await t.fetch('/clerk-webhook', { method: 'POST', body, headers });
    expect(res.status).toBe(200);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      email: 'new@example.test',
      profileImageUrl: 'https://img/ada-2',
    });
    // Svix retries on any non-2xx; a duplicate delivery must be a no-op, not a second write.
    const again = await t.fetch('/clerk-webhook', { method: 'POST', body, headers });
    expect(again.status).toBe(200);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ email: 'new@example.test' });
  });

  test('an address removed in Clerk clears the mirror — the old one must not keep receiving mail', async () => {
    const t = convexTest(schema, modules);
    const id = await seedAda(t);
    const { body, headers } = signed(
      userEvent('user.updated', { ...ADA, primary_email_address_id: null, email_addresses: [] }),
    );
    expect((await t.fetch('/clerk-webhook', { method: 'POST', body, headers })).status).toBe(200);
    expect((await t.run((ctx) => ctx.db.get(id)))?.email).toBeUndefined();
  });

  test('a bad signature, a tampered body, a stale timestamp and missing headers are all 400', async () => {
    const t = convexTest(schema, modules);
    const id = await seedAda(t);
    const good = signed(userEvent('user.updated', ADA));

    const wrongKey = signed(
      userEvent('user.updated', ADA),
      `whsec_${btoa('another-secret-entirely!!')}`,
    );
    expect(
      (
        await t.fetch('/clerk-webhook', {
          method: 'POST',
          body: wrongKey.body,
          headers: wrongKey.headers,
        })
      ).status,
    ).toBe(400);

    const tampered = good.body.replace('new@example.test', 'attacker@example.test');
    expect(
      (await t.fetch('/clerk-webhook', { method: 'POST', body: tampered, headers: good.headers }))
        .status,
    ).toBe(400);

    const stale = signed(
      userEvent('user.updated', ADA),
      SECRET,
      new Date(Date.now() - 10 * 60_000),
    );
    expect(
      (
        await t.fetch('/clerk-webhook', {
          method: 'POST',
          body: stale.body,
          headers: stale.headers,
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await t.fetch('/clerk-webhook', {
          method: 'POST',
          body: good.body,
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);

    expect((await t.run((ctx) => ctx.db.get(id)))?.email).toBe('old@example.test');
  });

  test('no signing secret configured is a 500, so the misconfiguration surfaces and Svix retries', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', '');
    const { body, headers } = signed(userEvent('user.updated', ADA));
    expect((await t.fetch('/clerk-webhook', { method: 'POST', body, headers })).status).toBe(500);
  });

  test('never un-scrubs a ghost; an unknown user, a deletion and an unrelated event are 200 no-ops', async () => {
    const t = convexTest(schema, modules);
    const id = await seedAda(t);
    await t.run((ctx) =>
      ctx.db.patch(id, {
        deletionRequestedAt: Date.now(),
        email: undefined,
        profileImageUrl: undefined,
      }),
    );
    const ghost = signed(userEvent('user.updated', ADA));
    expect(
      (
        await t.fetch('/clerk-webhook', {
          method: 'POST',
          body: ghost.body,
          headers: ghost.headers,
        })
      ).status,
    ).toBe(200);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.email).toBeUndefined();
    expect(row?.profileImageUrl).toBeUndefined();

    for (const payload of [
      userEvent('user.updated', { ...ADA, id: 'clerk_nobody' }),
      userEvent('user.deleted', { id: 'clerk_ada', deleted: true }),
      { type: 'session.created', object: 'event', data: { id: 's' } },
    ]) {
      const { body, headers } = signed(payload);
      expect((await t.fetch('/clerk-webhook', { method: 'POST', body, headers })).status).toBe(200);
    }
    // The deletion event did not touch the row: the D62 lifecycle owns that.
    expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
    // And the profile is still whole for the app.
    expect(
      await t.withIdentity({ subject: 'clerk_ada' }).query(api.profiles.current, {}),
    ).not.toBeNull();
  });
});
