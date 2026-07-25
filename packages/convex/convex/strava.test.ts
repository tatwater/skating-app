import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedActivity(t: ReturnType<typeof convexTest>, userId: Id<'profiles'>) {
  return t.run((ctx) =>
    ctx.db.insert('gpsActivities', {
      userId,
      provider: 'native' as const,
      providerActivityId: `key-${userId}`,
      sportType: 'IceSkate',
      startTime: T0,
      endTime: T0 + 3_600_000,
      path: {
        type: 'LineString' as const,
        coordinates: Array.from({ length: 12 }, (_, i) => [-72.15 + i * 0.001, 43.9]),
      },
      promptState: 'pending' as const,
      detectedAt: T0,
    }),
  );
}

async function seedConnection(
  t: ReturnType<typeof convexTest>,
  userId: Id<'profiles'>,
  overrides: { tokenExpiresAt?: number } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('activityConnections', {
      userId,
      provider: 'strava' as const,
      externalUserId: '12345',
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      scopes: ['read', 'activity:write'],
      tokenExpiresAt: overrides.tokenExpiresAt ?? Date.now() + 6 * 3_600_000,
      connectedAt: Date.now(),
    }),
  );
}

/** A `fetch` stub that answers by URL + method, recording every call. */
function stubFetch(routes: Array<{ match: RegExp; method?: string; body: unknown; ok?: boolean }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fake = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body });
    const route = routes.find(
      (r) => r.match.test(url) && (r.method === undefined || r.method === method),
    );
    if (!route) throw new Error(`unstubbed fetch: ${method} ${url}`);
    return {
      ok: route.ok ?? true,
      status: route.ok === false ? 500 : 200,
      json: async () => route.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fake);
  return calls;
}

beforeEach(() => {
  vi.stubEnv('STRAVA_CLIENT_ID', 'client-id');
  vi.stubEnv('STRAVA_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the connect flow is bound to a user by a single-use nonce', () => {
  test('beginConnect mints a state row and an authorize URL carrying it', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const { authorizeUrl } = await user.as.mutation(api.strava.beginConnect, {});

    const states = await t.run((ctx) => ctx.db.query('oauthStates').collect());
    expect(states).toHaveLength(1);
    expect(states[0]?.userId).toBe(user.id);
    expect(authorizeUrl).toContain('https://www.strava.com/oauth/authorize');
    expect(authorizeUrl).toContain(`state=${states[0]?.state}`);
    expect(authorizeUrl).toContain('activity%3Awrite');
    // We ask for nothing we can legally act on — no `activity:read_all`, no follower scopes.
    expect(authorizeUrl).not.toContain('read_all');
  });

  test('requires a signed-in user, and refuses when Strava is unconfigured', async () => {
    const t = harness();
    await expect(t.mutation(api.strava.beginConnect, {})).rejects.toThrow();

    vi.stubEnv('STRAVA_CLIENT_ID', '');
    const user = await seedUser(t, 'skater');
    await expect(user.as.mutation(api.strava.beginConnect, {})).rejects.toThrow(/not configured/i);
  });

  test('a state is consumed exactly once — a replayed callback finds nothing', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await user.as.mutation(api.strava.beginConnect, {});
    const state = (await t.run((ctx) => ctx.db.query('oauthStates').collect()))[0]?.state as string;

    const first = await t.mutation(internal.strava.consumeOAuthState, { state });
    expect(first?.userId).toBe(user.id);
    // This is the replay the nonce exists to stop: a second use of the same callback URL.
    expect(await t.mutation(internal.strava.consumeOAuthState, { state })).toBeNull();
  });

  test('an expired state is refused (and still burned)', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await t.run((ctx) =>
      ctx.db.insert('oauthStates', {
        state: 'stale',
        userId: user.id,
        provider: 'strava' as const,
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 1000,
      }),
    );
    expect(await t.mutation(internal.strava.consumeOAuthState, { state: 'stale' })).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('oauthStates').collect())).toHaveLength(0);
  });

  test('completeConnect exchanges the code and stores the tokens against the right user', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await user.as.mutation(api.strava.beginConnect, {});
    const state = (await t.run((ctx) => ctx.db.query('oauthStates').collect()))[0]?.state as string;

    stubFetch([
      {
        match: /oauth\/token/,
        body: {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_at: Math.floor(Date.now() / 1000) + 21_600,
          athlete: { id: 999 },
        },
      },
    ]);

    const outcome = await t.action(internal.strava.completeConnect, { code: 'abc', state });
    expect(outcome.ok).toBe(true);

    const connections = await t.run((ctx) => ctx.db.query('activityConnections').collect());
    expect(connections).toHaveLength(1);
    expect(connections[0]?.userId).toBe(user.id);
    expect(connections[0]?.externalUserId).toBe('999');
    expect(connections[0]?.accessToken).toBe('access-new');
  });

  test('a callback with an unknown state connects nobody', async () => {
    const t = harness();
    stubFetch([{ match: /oauth\/token/, body: {} }]);
    const outcome = await t.action(internal.strava.completeConnect, {
      code: 'abc',
      state: 'forged',
    });
    expect(outcome.ok).toBe(false);
    expect(await t.run((ctx) => ctx.db.query('activityConnections').collect())).toHaveLength(0);
  });
});

describe('connectionStatus / disconnect', () => {
  test('exposes only whether a connection exists — never the tokens', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    expect(await user.as.query(api.strava.connectionStatus, {})).toMatchObject({
      connected: false,
      configured: true,
    });

    await seedConnection(t, user.id);
    const status = await user.as.query(api.strava.connectionStatus, {});
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain('access-old');
    expect(JSON.stringify(status)).not.toContain('refresh-old');
  });

  test('disconnect forgets the tokens but keeps every track — they were always ours', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedConnection(t, user.id);
    const activityId = await seedActivity(t, user.id);

    await user.as.mutation(api.strava.disconnect, {});
    expect(await t.run((ctx) => ctx.db.query('activityConnections').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(activityId))).not.toBeNull();
  });
});

describe('pushActivity (upload → poll)', () => {
  test('uploads a GPX and returns the created activity id', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedConnection(t, user.id);
    const activityId = await seedActivity(t, user.id);

    const calls = stubFetch([
      { match: /api\/v3\/uploads\/\d+/, method: 'GET', body: { activity_id: 555, error: null } },
      { match: /api\/v3\/uploads$/, method: 'POST', body: { id: 42 } },
      { match: /api\/v3\/activities\/\d+/, method: 'PUT', body: {} },
    ]);

    const result = await user.as.action(api.strava.pushActivity, { activityId });
    expect(result).toMatchObject({ ok: true, activityId: 555 });

    const upload = calls.find((c) => c.method === 'POST');
    expect(upload?.url).toContain('/api/v3/uploads');
    // GPX has no formal sport vocabulary, so the type is also set explicitly afterwards — otherwise
    // the skate lands on Strava as a generic workout.
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/activities/555'))).toBe(true);
  }, 30_000);

  test("surfaces Strava's duplicate rejection rather than retrying forever", async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedConnection(t, user.id);
    const activityId = await seedActivity(t, user.id);

    stubFetch([
      {
        match: /api\/v3\/uploads\/\d+/,
        method: 'GET',
        body: { activity_id: null, error: 'duplicate of activity 123' },
      },
      { match: /api\/v3\/uploads$/, method: 'POST', body: { id: 42 } },
    ]);

    const result = await user.as.action(api.strava.pushActivity, { activityId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicate/i);
  }, 30_000);

  test('refreshes an expired access token before uploading', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await seedConnection(t, user.id, { tokenExpiresAt: Date.now() - 1000 });
    const activityId = await seedActivity(t, user.id);

    const calls = stubFetch([
      {
        match: /oauth\/token/,
        body: {
          access_token: 'access-fresh',
          refresh_token: 'refresh-fresh',
          expires_at: Math.floor(Date.now() / 1000) + 21_600,
        },
      },
      { match: /api\/v3\/uploads\/\d+/, method: 'GET', body: { activity_id: 7, error: null } },
      { match: /api\/v3\/uploads$/, method: 'POST', body: { id: 1 } },
      { match: /api\/v3\/activities\/\d+/, method: 'PUT', body: {} },
    ]);

    const result = await user.as.action(api.strava.pushActivity, { activityId });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.url.includes('oauth/token'))).toBe(true);
    // ...and the refreshed pair is persisted, so the next upload doesn't refresh again.
    const connection = (await t.run((ctx) => ctx.db.query('activityConnections').collect()))[0];
    expect(connection?.accessToken).toBe('access-fresh');
    expect(connection?.refreshToken).toBe('refresh-fresh');
  }, 30_000);

  test('never uploads one user’s skate from another user’s account', async () => {
    const t = harness();
    const owner = await seedUser(t, 'owner');
    const other = await seedUser(t, 'other');
    await seedConnection(t, other.id);
    const activityId = await seedActivity(t, owner.id);

    stubFetch([{ match: /./, body: {} }]);
    const result = await other.as.action(api.strava.pushActivity, { activityId });
    expect(result).toMatchObject({ ok: false, error: 'Not your activity' });
  });

  test('reports a missing connection instead of failing obscurely', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    const activityId = await seedActivity(t, user.id);
    stubFetch([{ match: /./, body: {} }]);
    expect(await user.as.action(api.strava.pushActivity, { activityId })).toMatchObject({
      ok: false,
      error: 'Strava is not connected',
    });
  });

  test('is a quiet no-op when the deployment has no Strava credentials', async () => {
    const t = harness();
    vi.stubEnv('STRAVA_CLIENT_ID', '');
    const user = await seedUser(t, 'skater');
    const activityId = await seedActivity(t, user.id);
    expect(await user.as.action(api.strava.pushActivity, { activityId })).toMatchObject({
      ok: false,
      error: 'Strava is not configured',
    });
  });
});

describe('pruneOAuthStates', () => {
  test('sweeps expired nonces and leaves live ones alone', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await t.run(async (ctx) => {
      await ctx.db.insert('oauthStates', {
        state: 'expired',
        userId: user.id,
        provider: 'strava' as const,
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 10_000,
      });
      await ctx.db.insert('oauthStates', {
        state: 'live',
        userId: user.id,
        provider: 'strava' as const,
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      });
    });

    expect(await t.mutation(internal.strava.pruneOAuthStates, {})).toEqual({ pruned: 1 });
    const left = await t.run((ctx) => ctx.db.query('oauthStates').collect());
    expect(left.map((r) => r.state)).toEqual(['live']);
  });
});

describe('the /strava/callback endpoint', () => {
  /** Drive the real HTTP route the way Strava will. */
  function callback(t: ReturnType<typeof convexTest>, query: Record<string, string>) {
    const params = new URLSearchParams(query).toString();
    return t.fetch(`/strava/callback?${params}`, { method: 'GET' });
  }

  test('bounces back into the app via the deep link the flow started with', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await user.as.mutation(api.strava.beginConnect, { redirectTo: 'skating://settings' });
    const state = (await t.run((ctx) => ctx.db.query('oauthStates').collect()))[0]?.state as string;

    stubFetch([
      {
        match: /oauth\/token/,
        body: {
          access_token: 'a',
          refresh_token: 'r',
          expires_at: Math.floor(Date.now() / 1000) + 21_600,
          athlete: { id: 1 },
        },
      },
    ]);

    const res = await callback(t, { code: 'abc', state });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('skating://settings?strava=connected');
  });

  test('a declined authorization comes back as declined, without touching the token endpoint', async () => {
    const t = harness();
    // No fetch stub at all: reaching Strava here would throw, which is the assertion.
    const res = await callback(t, { error: 'access_denied' });
    expect(res.status).toBe(200); // no target and no WEB_APP_URL ⇒ the fallback page
    expect(await res.text()).toContain('Strava not connected');
  });

  test('renders a page instead of a dead-end relative redirect when nothing is configured', async () => {
    const t = harness();
    const res = await callback(t, { state: 'forged' }); // no code ⇒ failed, no target
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain("Couldn't connect Strava");
    // The bug this pins: a relative Location resolves against the .site host and 404s.
    expect(res.headers.get('Location')).toBeNull();
  });

  test('falls back to the configured web app when there is no deep link', async () => {
    vi.stubEnv('WEB_APP_URL', 'https://skating.example');
    const t = harness();
    const res = await callback(t, { error: 'access_denied' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://skating.example/settings?strava=declined');
  });

  test('a forged state connects nobody and still lands somewhere intelligible', async () => {
    vi.stubEnv('WEB_APP_URL', 'https://skating.example');
    const t = harness();
    stubFetch([{ match: /oauth\/token/, body: {} }]);
    const res = await callback(t, { code: 'abc', state: 'forged' });
    expect(res.headers.get('Location')).toBe('https://skating.example/settings?strava=failed');
    expect(await t.run((ctx) => ctx.db.query('activityConnections').collect())).toHaveLength(0);
  });
});

describe('beginConnect refuses an unsafe return target (open-redirect guard)', () => {
  test('rejects a foreign origin before it ever reaches the database', async () => {
    vi.stubEnv('WEB_APP_URL', 'https://skating.example');
    const t = harness();
    const user = await seedUser(t, 'skater');
    await expect(
      user.as.mutation(api.strava.beginConnect, { redirectTo: 'https://evil.example/steal' }),
    ).rejects.toThrow(/Unsafe redirect/i);
    expect(await t.run((ctx) => ctx.db.query('oauthStates').collect())).toHaveLength(0);
  });

  test('accepts the app deep link', async () => {
    const t = harness();
    const user = await seedUser(t, 'skater');
    await expect(
      user.as.mutation(api.strava.beginConnect, { redirectTo: 'skating://settings' }),
    ).resolves.toBeDefined();
  });
});
