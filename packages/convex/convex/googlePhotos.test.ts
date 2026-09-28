import { GOOGLE_PHOTOS_PICKER_SCOPE } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const NOTIF_PREFS = {
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
};

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

type Route = {
  match: RegExp;
  method?: string;
  body?: unknown;
  ok?: boolean;
  bytes?: number;
  contentType?: string;
};
type Call = { url: string; method: string; auth: string | null };

/** A `fetch` stub that answers by URL + method, recording every call and its bearer. */
function stubFetch(routes: Route[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, auth: headers.Authorization ?? null });
      const route = routes.find(
        (r) => r.match.test(url) && (r.method === undefined || r.method === method),
      );
      if (!route) throw new Error(`unstubbed fetch: ${method} ${url}`);
      return {
        ok: route.ok ?? true,
        status: route.ok === false ? 500 : 200,
        json: async () => route.body,
        arrayBuffer: async () => new ArrayBuffer(route.bytes ?? 16),
        headers: new Headers(route.contentType ? { 'content-type': route.contentType } : {}),
      } as Response;
    }),
  );
  return calls;
}

const SESSION = {
  id: 'sess-1',
  pickerUri: 'https://photos.google.com/picker/sess-1',
  pollingConfig: { pollInterval: '4s', timeoutIn: '1800s' },
};

const TOKEN = {
  access_token: 'tok',
  expires_in: 3599,
  scope: GOOGLE_PHOTOS_PICKER_SCOPE,
};

/** Start a pick as `subject` and walk the browser through start + callback with the cookie. */
async function pick(t: ReturnType<typeof convexTest>, subject = 'skater') {
  const user = await seedUser(t, subject);
  const { state, startUrl } = await user.as.mutation(api.googlePhotos.begin, {});
  const start = await t.fetch(new URL(startUrl).pathname + new URL(startUrl).search, {
    method: 'GET',
  });
  return { user, state, start };
}

function callback(
  t: ReturnType<typeof convexTest>,
  query: Record<string, string>,
  cookieState?: string,
) {
  return t.fetch(`/google-photos/callback?${new URLSearchParams(query)}`, {
    method: 'GET',
    ...(cookieState ? { headers: { Cookie: `skating_oauth_state=${cookieState}` } } : {}),
  });
}

beforeEach(() => {
  vi.stubEnv('GOOGLE_PHOTOS_CLIENT_ID', 'gp-client');
  vi.stubEnv('GOOGLE_PHOTOS_CLIENT_SECRET', 'gp-secret');
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('availability and consent', () => {
  test('is off, and refuses to begin, without the client', async () => {
    vi.stubEnv('GOOGLE_PHOTOS_CLIENT_SECRET', '');
    const t = convexTest(schema, modules);
    const user = await seedUser(t, 'skater');
    expect(await t.query(api.googlePhotos.available, {})).toBe(false);
    await expect(user.as.mutation(api.googlePhotos.begin, {})).rejects.toThrow(/not set up/);
  });

  test('begins with our own start URL, which binds the browser and forwards to Google', async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.googlePhotos.available, {})).toBe(true);
    const { state, start } = await pick(t);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('Location') as string);
    expect(location.hostname).toBe('accounts.google.com');
    expect(location.searchParams.get('state')).toBe(state);
    expect(location.searchParams.get('access_type')).toBe('online');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://example.convex.site/google-photos/callback',
    );
    const cookie = start.headers.get('Set-Cookie') as string;
    expect(cookie).toContain(`skating_oauth_state=${state}`);
    expect(cookie).toContain('Path=/google-photos');
  });

  test('a dead state never reaches Google', async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch('/google-photos/start?state=nope', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Couldn't open Google Photos");
  });

  test('a Strava nonce is never a Google Photos one', async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t, 'skater');
    await t.run((ctx) =>
      ctx.db.insert('oauthStates', {
        state: 'strava-state',
        userId: user.id,
        provider: 'strava',
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      }),
    );
    expect(await t.query(internal.googlePhotos.peekState, { state: 'strava-state' })).toBe(false);
    expect(
      await t.mutation(internal.googlePhotos.consumeState, { state: 'strava-state' }),
    ).toBeNull();
  });
});

describe('the callback', () => {
  test('opens a picker session and sends the window to it', async () => {
    const t = convexTest(schema, modules);
    const { state, user } = await pick(t);
    const calls = stubFetch([
      { match: /oauth2\.googleapis\.com\/token/, method: 'POST', body: TOKEN },
      { match: /\/v1\/sessions$/, method: 'POST', body: SESSION },
    ]);
    const res = await callback(t, { code: 'c', state }, state);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://photos.google.com/picker/sess-1/autoclose');
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(calls.find((c) => /sessions$/.test(c.url))?.auth).toBe('Bearer tok');
    const rows = await t.run((ctx) => ctx.db.query('photoPickerSessions').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(user.id);
    expect(rows[0]?.pollIntervalMs).toBe(4000);
    // The state is spent with the session's own write.
    expect(await t.run((ctx) => ctx.db.query('oauthStates').collect())).toHaveLength(0);
  });

  test('refuses a browser that did not start the flow, before any exchange', async () => {
    const t = convexTest(schema, modules);
    const { state } = await pick(t);
    const calls = stubFetch([]);
    const res = await callback(t, { code: 'victim-code', state });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('oauthStates').collect())).toHaveLength(0);
  });

  test('says so when the person declines, and ends the pick', async () => {
    const t = convexTest(schema, modules);
    const { state, user } = await pick(t);
    const res = await callback(t, { error: 'access_denied', state }, state);
    expect(await res.text()).toContain('Google Photos not opened');
    expect(await user.as.action(api.googlePhotos.status, { state })).toEqual({ phase: 'gone' });
  });

  test('treats an unticked scope as declined', async () => {
    const t = convexTest(schema, modules);
    const { state } = await pick(t);
    stubFetch([{ match: /token/, method: 'POST', body: { ...TOKEN, scope: 'openid' } }]);
    const res = await callback(t, { code: 'c', state }, state);
    expect(await res.text()).toContain('Google Photos not opened');
    expect(await t.run((ctx) => ctx.db.query('photoPickerSessions').collect())).toHaveLength(0);
  });

  test('ends the pick when Google will not open a session', async () => {
    const t = convexTest(schema, modules);
    const { state, user } = await pick(t);
    stubFetch([
      { match: /token/, method: 'POST', body: TOKEN },
      { match: /sessions$/, method: 'POST', ok: false, body: {} },
    ]);
    const res = await callback(t, { code: 'c', state }, state);
    expect(await res.text()).toContain("Couldn't open Google Photos");
    expect(await user.as.action(api.googlePhotos.status, { state })).toEqual({ phase: 'gone' });
  });

  test('stores nothing for an account on its way out, and closes the session at Google', async () => {
    const t = convexTest(schema, modules);
    const { state, user } = await pick(t);
    await t.run((ctx) => ctx.db.patch(user.id, { status: 'deleting' as const }));
    const calls = stubFetch([
      { match: /token/, method: 'POST', body: TOKEN },
      { match: /sessions$/, method: 'POST', body: SESSION },
      { match: /sessions\/sess-1$/, method: 'DELETE', body: {} },
    ]);
    const res = await callback(t, { code: 'c', state }, state);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(await t.run((ctx) => ctx.db.query('photoPickerSessions').collect())).toHaveLength(0);
  });
});

describe('the page: status, list, photo, close', () => {
  async function opened(t: ReturnType<typeof convexTest>) {
    const p = await pick(t);
    stubFetch([
      { match: /token/, method: 'POST', body: TOKEN },
      { match: /sessions$/, method: 'POST', body: SESSION },
    ]);
    await callback(t, { code: 'c', state: p.state }, p.state);
    return p;
  }

  test('says the person is still on the consent screen, then picking, then picked', async () => {
    const t = convexTest(schema, modules);
    const { state, user } = await pick(t);
    expect(await user.as.action(api.googlePhotos.status, { state })).toEqual({
      phase: 'consent',
      pollIntervalMs: 2000,
    });
    // Between the consume and the session's row, still going — never "gone".
    await t.mutation(internal.googlePhotos.consumeState, { state });
    expect((await user.as.action(api.googlePhotos.status, { state })).phase).toBe('consent');
    await t.run(async (ctx) => {
      const row = await ctx.db.query('oauthStates').first();
      if (row) await ctx.db.delete(row._id);
    });

    const t2 = convexTest(schema, modules);
    const o = await opened(t2);
    stubFetch([{ match: /sessions\/sess-1$/, body: SESSION }]);
    expect(await o.user.as.action(api.googlePhotos.status, { state: o.state })).toEqual({
      phase: 'picking',
      pollIntervalMs: 4000,
    });
    stubFetch([{ match: /sessions\/sess-1$/, body: { ...SESSION, mediaItemsSet: true } }]);
    expect(await o.user.as.action(api.googlePhotos.status, { state: o.state })).toEqual({
      phase: 'picked',
    });
  });

  test("never answers for another person's pick", async () => {
    const t = convexTest(schema, modules);
    const o = await opened(t);
    const other = await seedUser(t, 'other');
    stubFetch([]);
    expect(await other.as.action(api.googlePhotos.status, { state: o.state })).toEqual({
      phase: 'gone',
    });
    await expect(other.as.action(api.googlePhotos.list, { state: o.state })).rejects.toThrow(
      /ended/,
    );
  });

  test('lists the picked photos, records them, and fetches only those', async () => {
    const t = convexTest(schema, modules);
    const o = await opened(t);
    const item = (id: string, type = 'PHOTO') => ({
      id,
      type,
      createTime: '2026-01-10T19:10:00Z',
      mediaFile: {
        baseUrl: `https://lh3.googleusercontent.com/${id}`,
        mimeType: 'image/jpeg',
        filename: `${id}.jpg`,
      },
    });
    stubFetch([
      {
        match: /mediaItems\?sessionId=sess-1&pageSize=100$/,
        body: { mediaItems: [item('a'), item('v', 'VIDEO')], nextPageToken: 'p2' },
      },
      { match: /pageToken=p2/, body: { mediaItems: [item('b')] } },
    ]);
    const listed = await o.user.as.action(api.googlePhotos.list, { state: o.state });
    expect(listed.map((p) => p.id)).toEqual(['a', 'b']);
    expect(listed[0]?.takenAtMs).toBe(Date.parse('2026-01-10T19:10:00Z'));

    const calls = stubFetch([
      {
        match: /lh3\.googleusercontent\.com\/a=w2048-h2048$/,
        bytes: 1234,
        contentType: 'image/jpeg',
      },
    ]);
    const got = await o.user.as.action(api.googlePhotos.photo, { state: o.state, itemId: 'a' });
    expect(got.bytes.byteLength).toBe(1234);
    expect(got.mimeType).toBe('image/jpeg');
    expect(calls[0]?.auth).toBe('Bearer tok');
    await expect(
      o.user.as.action(api.googlePhotos.photo, { state: o.state, itemId: 'v' }),
    ).rejects.toThrow(/not part of this pick/);
  });

  test('refuses a photo too large to return', async () => {
    const t = convexTest(schema, modules);
    const o = await opened(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('photoPickerSessions').first();
      if (row)
        await ctx.db.patch(row._id, {
          items: [
            { id: 'a', baseUrl: 'https://lh3.googleusercontent.com/a', mimeType: 'image/jpeg' },
          ],
        });
    });
    stubFetch([{ match: /googleusercontent/, bytes: 9 * 1024 * 1024 }]);
    await expect(
      o.user.as.action(api.googlePhotos.photo, { state: o.state, itemId: 'a' }),
    ).rejects.toThrow(/too large/);
  });

  test('close deletes the session at Google and its row here', async () => {
    const t = convexTest(schema, modules);
    const o = await opened(t);
    const calls = stubFetch([{ match: /sessions\/sess-1$/, method: 'DELETE', body: {} }]);
    await o.user.as.action(api.googlePhotos.close, { state: o.state });
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
    expect(await t.run((ctx) => ctx.db.query('photoPickerSessions').collect())).toHaveLength(0);
    // Idempotent.
    await o.user.as.action(api.googlePhotos.close, { state: o.state });
  });
});

describe('what is left behind', () => {
  async function seedSession(
    t: ReturnType<typeof convexTest>,
    userId: Id<'profiles'>,
    expiresAt: number,
  ) {
    return t.run((ctx) =>
      ctx.db.insert('photoPickerSessions', {
        userId,
        state: `s-${expiresAt}`,
        sessionId: 'sess',
        accessToken: 'tok',
        pickerUri: 'https://photos.google.com/picker/sess',
        pollIntervalMs: 5000,
        expiresAt,
        createdAt: Date.now(),
      }),
    );
  }

  test('the sweep drops rows past their hour', async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t, 'skater');
    await seedSession(t, user.id, Date.now() - 1);
    await seedSession(t, user.id, Date.now() + 60_000);
    expect(await t.mutation(internal.googlePhotos.pruneSessions, {})).toEqual({ pruned: 1 });
    expect(await t.run((ctx) => ctx.db.query('photoPickerSessions').collect())).toHaveLength(1);
  });
});
