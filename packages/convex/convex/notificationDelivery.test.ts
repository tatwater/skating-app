import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: true,
  greatReportNearby: false,
};

async function seedUser(
  t: ReturnType<typeof harness>,
  subject: string,
  over: { email?: string; channelPrefs?: { push: boolean; email: boolean } } = {},
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      ...(over.email !== undefined ? { email: over.email } : {}),
      ...(over.channelPrefs !== undefined ? { channelPrefs: over.channelPrefs } : {}),
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

/** A delivered inbox row of a given type, straight into the table (the flush is tested elsewhere). */
async function seedNotification(
  t: ReturnType<typeof harness>,
  userId: Id<'profiles'>,
  type: 'content_flag_resolved' | 'report_rated' | 'nearby_report_digest',
  payload: Record<string, unknown>,
) {
  return t.run((ctx) =>
    ctx.db.insert('notifications', { userId, type, payload, createdAt: Date.now() }),
  );
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` stub answering by URL, recording every call with its parsed JSON body. */
function stubFetch(routes: Array<{ match: RegExp; body: unknown; ok?: boolean }>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      const route = routes.find((r) => r.match.test(url));
      if (!route) throw new Error(`unstubbed fetch: ${url}`);
      return {
        ok: route.ok ?? true,
        status: route.ok === false ? 500 : 200,
        statusText: route.ok === false ? 'Internal Server Error' : 'OK',
        json: async () => (typeof route.body === 'function' ? route.body() : route.body),
      } as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('RESEND_FROM_EMAIL', 'Gli Updates <updates@example.test>');
  vi.stubEnv('WEB_APP_URL', 'https://app.example.test');
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const FLAG_PAYLOAD = {
  kind: 'flag_resolved',
  flagId: 'x',
  resolution: 'actioned',
  coalesceKey: 'k',
};

describe('pushTokens', () => {
  test('register is owner-scoped, idempotent per token, and re-homes a token to whoever is signed in', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const token = 'ExponentPushToken[abc123]';
    const first = await a.as.mutation(api.pushTokens.register, { token, platform: 'android' });
    const again = await a.as.mutation(api.pushTokens.register, { token, platform: 'android' });
    expect(again).toBe(first);
    await expect(
      a.as.mutation(api.pushTokens.register, { token: 'not-a-token', platform: 'android' }),
    ).rejects.toThrow(/Expo push token/);

    // Same phone, different account: the row moves.
    await b.as.mutation(api.pushTokens.register, { token, platform: 'android' });
    const rows = await t.run((ctx) => ctx.db.query('pushTokens').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(b.id);

    // Unregister is owner-only: a's attempt on b's row is a no-op.
    await a.as.mutation(api.pushTokens.unregister, { token });
    expect(await t.run((ctx) => ctx.db.query('pushTokens').collect())).toHaveLength(1);
    await b.as.mutation(api.pushTokens.unregister, { token });
    expect(await t.run((ctx) => ctx.db.query('pushTokens').collect())).toHaveLength(0);
  });
});

describe('notificationDelivery', () => {
  test('the flush hands its inserts to deliverBatch', async () => {
    const t = harness();
    const me = await seedUser(t, 'me');
    await t.run(async (ctx) => {
      const flagId = await ctx.db.insert('contentFlags', {
        flaggerId: me.id,
        targetType: 'report',
        targetId: 'r',
        reason: 'spam',
        status: 'actioned',
        origin: 'user',
        createdAt: Date.now(),
      });
      await ctx.db.insert('notificationQueue', {
        userId: me.id,
        kind: 'flag_resolved',
        type: 'content_flag_resolved',
        coalesceKey: `${me.id}:f:flag_resolved`,
        count: 1,
        flushAfter: Date.now() - 1,
        createdAt: Date.now() - 1,
        trigger: { kind: 'flag_resolved', flagId, resolution: 'actioned' },
      });
    });
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.some((f) => f.name.includes('notificationDelivery'))).toBe(true);
  });

  test('pushes to every live token, emails the eligible type with an unsubscribe link, stamps both', async () => {
    const t = harness();
    const me = await seedUser(t, 'me', { email: 'me@example.test' });
    const phone = 'ExponentPushToken[phone]';
    const tablet = 'ExponentPushToken[tablet]';
    const dead = 'ExponentPushToken[dead]';
    await me.as.mutation(api.pushTokens.register, { token: phone, platform: 'android' });
    await me.as.mutation(api.pushTokens.register, { token: tablet, platform: 'ios' });
    await me.as.mutation(api.pushTokens.register, { token: dead, platform: 'android' });
    const flag = await seedNotification(t, me.id, 'content_flag_resolved', FLAG_PAYLOAD);
    // A thumb is push-and-inbox only — never an email.
    const thumb = await seedNotification(t, me.id, 'report_rated', {
      kind: 'thumb',
      targetType: 'report',
      targetId: 'r',
      actorIds: [],
      count: 1,
      coalesceKey: 'k2',
    });

    const calls = stubFetch([
      {
        match: /exp\.host.*push\/send/,
        body: () => ({
          data: [
            { status: 'ok', id: 't1' },
            { status: 'ok', id: 't2' },
            { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
            { status: 'ok', id: 't4' },
            { status: 'ok', id: 't5' },
            { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          ],
        }),
      },
      { match: /api\.resend\.com/, body: { id: 'email-1' } },
    ]);

    const result = await t.action(internal.notificationDelivery.deliverBatch, {
      notificationIds: [flag, thumb],
    });
    expect(result).toMatchObject({
      rows: 2,
      pushMessages: 6,
      pushed: 2,
      emailed: 1,
      deadTokens: 1,
    });

    const push = calls.find((c) => /push\/send/.test(c.url));
    const messages = push?.body as {
      to: string;
      title: string;
      collapseId: string;
      data: unknown;
    }[];
    expect(messages).toHaveLength(6);
    expect(messages.map((m) => m.to).sort()).toEqual(
      [dead, dead, phone, phone, tablet, tablet].sort(),
    );
    expect(messages[0]?.title).toMatch(/moderator reviewed/);
    expect(messages.every((m) => m.collapseId.length <= 64)).toBe(true);

    const mail = calls.find((c) => /resend/.test(c.url));
    const sent = mail?.body as {
      to: string;
      subject: string;
      html: string;
      headers: Record<string, string>;
    };
    expect(sent.to).toBe('me@example.test');
    expect(sent.subject).toMatch(/moderator reviewed/);
    expect(sent.headers['List-Unsubscribe']).toMatch(/example\.convex\.site\/unsubscribe\?u=.*&t=/);
    expect(sent.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent.html).toContain('/unsubscribe?u=');
    expect(calls.filter((c) => /resend/.test(c.url))).toHaveLength(1); // the thumb was not emailed

    const rows = await t.run((ctx) => ctx.db.query('notifications').collect());
    expect(rows.find((r) => r._id === flag)).toMatchObject({
      pushedAt: expect.any(Number),
      emailedAt: expect.any(Number),
    });
    const thumbRow = rows.find((r) => r._id === thumb);
    expect(thumbRow?.pushedAt).toEqual(expect.any(Number));
    expect(thumbRow?.emailedAt).toBeUndefined();
    const tokens = await t.run((ctx) => ctx.db.query('pushTokens').collect());
    expect(tokens.find((k) => k.token === dead)?.disabledAt).toEqual(expect.any(Number));
    expect(tokens.filter((k) => k.disabledAt === undefined)).toHaveLength(2);

    // The receipt check is scheduled for the ok tickets, and running twice sends nothing twice.
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.some((f) => f.name.includes('checkPushReceipts'))).toBe(true);
    const again = await t.action(internal.notificationDelivery.deliverBatch, {
      notificationIds: [flag, thumb],
    });
    expect(again).toMatchObject({ pushMessages: 0, pushed: 0, emailed: 0 });
  });

  test('channel switches and a dead unsubscribe path: off means nothing goes out', async () => {
    const t = harness();
    const me = await seedUser(t, 'me', {
      email: 'me@example.test',
      channelPrefs: { push: false, email: false },
    });
    await me.as.mutation(api.pushTokens.register, {
      token: 'ExponentPushToken[p]',
      platform: 'ios',
    });
    const flag = await seedNotification(t, me.id, 'content_flag_resolved', FLAG_PAYLOAD);
    const calls = stubFetch([]);
    const result = await t.action(internal.notificationDelivery.deliverBatch, {
      notificationIds: [flag],
    });
    expect(result).toMatchObject({ pushMessages: 0, emailed: 0 });
    expect(calls).toHaveLength(0);

    // Flip email back on through the setting, then off again through the unsubscribe secret.
    await me.as.mutation(api.profiles.setChannelPrefs, { email: true });
    expect((await me.as.query(api.profiles.current, {}))?.channelPrefs).toEqual({
      push: false,
      email: true,
    });
    const secret = await t.mutation(internal.notificationDelivery.ensureUnsubscribeSecret, {
      userId: me.id,
    });
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(
      await t.mutation(internal.profiles.unsubscribeEmailBySecret, {
        userId: me.id,
        secret: 'nope',
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.profiles.unsubscribeEmailBySecret, {
        userId: me.id,
        secret: secret ?? '',
      }),
    ).toBe(true);
    expect((await me.as.query(api.profiles.current, {}))?.channelPrefs).toEqual({
      push: false,
      email: false,
    });
  });

  test('the unsubscribe route answers a page on GET and 200 on the one-click POST', async () => {
    const t = harness();
    const me = await seedUser(t, 'me', { email: 'me@example.test' });
    const secret = await t.mutation(internal.notificationDelivery.ensureUnsubscribeSecret, {
      userId: me.id,
    });
    const bad = await t.fetch(`/unsubscribe?u=${me.id}&t=wrong`);
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain('didn’t work');
    const good = await t.fetch(`/unsubscribe?u=${me.id}&t=${secret}`, { method: 'POST' });
    expect(good.status).toBe(200);
    expect((await me.as.query(api.profiles.current, {}))?.channelPrefs?.email).toBe(false);
  });

  test('a missing email mirror falls back to one Clerk lookup and caches it', async () => {
    const t = harness();
    const me = await seedUser(t, 'me'); // no email on the profile
    const flag = await seedNotification(t, me.id, 'content_flag_resolved', FLAG_PAYLOAD);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
    const calls = stubFetch([
      {
        match: /api\.clerk\.com\/v1\/users\/me/,
        body: {
          primary_email_address_id: 'e2',
          email_addresses: [
            { id: 'e1', email_address: 'work@example.test' },
            { id: 'e2', email_address: 'home@example.test' },
          ],
        },
      },
      { match: /api\.resend\.com/, body: { id: 'email-1' } },
    ]);
    const result = await t.action(internal.notificationDelivery.deliverBatch, {
      notificationIds: [flag],
    });
    expect(result).toMatchObject({ emailed: 1 });
    const mail = calls.find((c) => /resend/.test(c.url));
    expect((mail?.body as { to: string } | undefined)?.to).toBe('home@example.test');
    expect((await t.run((ctx) => ctx.db.get(me.id)))?.email).toBe('home@example.test');
  });

  test('the receipt pass disables a token Expo reports dead', async () => {
    const t = harness();
    const me = await seedUser(t, 'me');
    const tokenId = await me.as.mutation(api.pushTokens.register, {
      token: 'ExponentPushToken[p]',
      platform: 'ios',
    });
    stubFetch([
      {
        match: /getReceipts/,
        body: {
          data: {
            t1: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          },
        },
      },
    ]);
    const result = await t.action(internal.notificationDelivery.checkPushReceipts, {
      tickets: [
        { id: 't1', tokenId: tokenId as Id<'pushTokens'> },
        { id: 't2', tokenId: tokenId as Id<'pushTokens'> },
      ],
    });
    expect(result).toEqual({ checked: 2, errors: 1, deadTokens: 1 });
    expect((await t.run((ctx) => ctx.db.get(tokenId as Id<'pushTokens'>)))?.disabledAt).toEqual(
      expect.any(Number),
    );
  });
});
