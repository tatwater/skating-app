/**
 * *From Google Photos* on the web (A10-8 §8.6, D207). Nothing reads a Google library by date any
 * more, so the person picks **inside Google's own Photos Picker**, and what comes back is only what
 * they picked.
 *
 * **No stored token, no connection.** Every use is its own consent (`access_type=online`, one tap
 * once granted), and the one-hour access token lives only in the picker session's row
 * (`photoPickerSessions`), which is deleted when the add is done or abandoned, swept once past its
 * hour, and erased with a departing account. There is nothing to disconnect, revoke or export, and
 * testing mode's seven-day refresh-token expiry never applies.
 *
 * The flow:
 *  1. `begin` mints a single-use state (`oauthStates`, `provider: 'google_photos'`) and returns our
 *     own `/google-photos/start`, which binds this browser (the session cookie, as Strava's flow
 *     does — see `core/oauthSession.ts` for the account-linking attack it stops) and forwards to
 *     Google's consent.
 *  2. The callback (`http.ts`) checks the cookie, and `openSession` consumes the state, trades the
 *     code for a token, creates a picker session, stores the row, and sends the window on to the
 *     picker, which closes itself when the person is done.
 *  3. The page polls `status` on the session's own interval; on `picked` it calls `list` (which
 *     records the picked items on the row), then `photo` per item — the bytes at D31's full edge,
 *     **never stored** — and finally `close`.
 *
 * Degrades quietly: with `GOOGLE_PHOTOS_CLIENT_ID` / `GOOGLE_PHOTOS_CLIENT_SECRET` unset, `available`
 * says no and the web shows no button.
 */

import {
  autoclosePickerUri,
  GOOGLE_PICKER_API,
  GOOGLE_PICKER_MAX_ITEMS,
  GOOGLE_TOKEN_URL,
  googlePhotosAuthorizeUrl,
  grantsPickerScope,
  readPickedPhotos,
  readPickerSession,
  sizedBaseUrl,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
  action,
  type DatabaseReader,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server';
import { canConnectAccount } from './lib/activityConnections';
import { requireContributor } from './lib/auth';

/** A consent nonce lives as long as Strava's: long enough to sign in to Google, no longer. */
const STATE_TTL_MS = 15 * 60 * 1000;
export const GOOGLE_PHOTOS_STATE_TTL_SECONDS = STATE_TTL_MS / 1000;

/** The cookie's path — our two routes, nothing else on the deployment. */
export const GOOGLE_PHOTOS_COOKIE_PATH = '/google-photos';

/** D31's full edge — Google scales the bytes, the browser still re-encodes them. */
const FULL_EDGE = 2048;

/** A photo larger than this is refused rather than returned: a 2048-px JPEG is a few MB at most. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Every call to Google is bounded, so a hung request cannot hold an action to its limit. */
const FETCH_TIMEOUT_MS = 20_000;

function configured(): boolean {
  return Boolean(process.env.GOOGLE_PHOTOS_CLIENT_ID && process.env.GOOGLE_PHOTOS_CLIENT_SECRET);
}

function redirectUri(): string {
  return `${process.env.CONVEX_SITE_URL}${GOOGLE_PHOTOS_COOKIE_PATH}/callback`;
}

/** Google's consent URL for a minted state — built in one place, so the redirect cannot drift. */
export function googlePhotosConsentUrl(state: string): string {
  return googlePhotosAuthorizeUrl({
    clientId: process.env.GOOGLE_PHOTOS_CLIENT_ID as string,
    redirectUri: redirectUri(),
    state,
  });
}

/** Is *From Google Photos* on for this deployment? The web hides the button when not. */
export const available = query({
  args: {},
  handler: async () => configured(),
});

// ── Consent ──────────────────────────────────────────────────────────────────────────────────

/** Start a pick: mint the state and return the page's own start URL (never Google's). */
export const begin = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireContributor(ctx);
    if (!configured()) throw new ConvexError('Google Photos is not set up on this deployment');
    const now = Date.now();
    const state = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
    await ctx.db.insert('oauthStates', {
      state,
      userId: profile._id,
      provider: 'google_photos',
      expiresAt: now + STATE_TTL_MS,
      createdAt: now,
    });
    return {
      state,
      startUrl: `${process.env.CONVEX_SITE_URL}${GOOGLE_PHOTOS_COOKIE_PATH}/start?state=${state}`,
    };
  },
});

/** The Google Photos state row for a nonce — a Strava nonce is never one, whatever it says. */
async function stateRow(
  ctx: { db: DatabaseReader },
  state: string,
): Promise<Doc<'oauthStates'> | null> {
  const row = await ctx.db
    .query('oauthStates')
    .withIndex('by_state', (q) => q.eq('state', state))
    .unique();
  return row && row.provider === 'google_photos' ? row : null;
}

/** Internal: is this a live Google Photos state? Peeked, never consumed — the start route runs first. */
export const peekState = internalQuery({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const row = await stateRow(ctx, args.state);
    return row !== null && row.consumedAt === undefined && row.expiresAt >= Date.now();
  },
});

/**
 * Internal: consume the state, returning whose pick it was. Single-use — a second consume gets
 * nothing — but **marked, not deleted**: the page is polling on it, and until the session's row
 * lands the pick is still going. `storeSession` deletes it with the same write; `dropState` on
 * every failure.
 */
export const consumeState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const row = await stateRow(ctx, args.state);
    if (!row || row.consumedAt !== undefined) return null;
    if (row.expiresAt < Date.now()) {
      await ctx.db.delete(row._id);
      return null;
    }
    await ctx.db.patch(row._id, { consumedAt: Date.now() });
    return { userId: row.userId };
  },
});

/** Internal: the callback failed — the pick is over, and the page's next poll says so. */
export const dropState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const row = await stateRow(ctx, args.state);
    if (row) await ctx.db.delete(row._id);
  },
});

/**
 * Internal: store the picker session. Refused for an account that is being deleted — the same gate
 * a Strava connection takes (`canConnectAccount`), because this row holds a live token too.
 */
export const storeSession = internalMutation({
  args: {
    userId: v.id('profiles'),
    state: v.string(),
    sessionId: v.string(),
    accessToken: v.string(),
    pickerUri: v.string(),
    pollIntervalMs: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const pending = await stateRow(ctx, args.state);
    if (pending) await ctx.db.delete(pending._id);
    if (!(await canConnectAccount(ctx, args.userId))) return { stored: false };
    await ctx.db.insert('photoPickerSessions', { ...args, createdAt: Date.now() });
    return { stored: true };
  },
});

async function google(
  url: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response | null> {
  const { token, ...rest } = init;
  try {
    return await fetch(url, {
      ...rest,
      headers: {
        ...(rest.headers as Record<string, string> | undefined),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      `googlePhotos: ${init.method ?? 'GET'} ${url.split('?')[0]} threw: ${String(err)}`,
    );
    return null;
  }
}

/**
 * Internal: the callback's work — consume the state, trade the code for a token, open a picker
 * session, store it. Returns the picker's URL for the window, or why not; never throws, because the
 * person is sitting in a browser window that should say something intelligible.
 */
export const openSession = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; pickerUri: string } | { ok: false; reason: 'declined' | 'failed' }> => {
    const claim = await ctx.runMutation(internal.googlePhotos.consumeState, { state: args.state });
    if (!claim) return { ok: false, reason: 'failed' };
    const fail = async (reason: 'declined' | 'failed') => {
      await ctx.runMutation(internal.googlePhotos.dropState, { state: args.state });
      return { ok: false as const, reason };
    };

    const tokenRes = await google(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: args.code,
        client_id: process.env.GOOGLE_PHOTOS_CLIENT_ID as string,
        client_secret: process.env.GOOGLE_PHOTOS_CLIENT_SECRET as string,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes?.ok) return fail('failed');
    const token = (await tokenRes.json()) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!token.access_token) return fail('failed');
    // The person unticked the one scope on Google's consent: nothing to pick with.
    if (!grantsPickerScope(token.scope)) return fail('declined');

    const now = Date.now();
    const created = await google(`${GOOGLE_PICKER_API}/sessions`, {
      method: 'POST',
      token: token.access_token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickingConfig: { maxItemCount: String(GOOGLE_PICKER_MAX_ITEMS) } }),
    });
    const session = created?.ok ? readPickerSession(await created.json(), now) : null;
    if (!session) return fail('failed');

    const tokenExpiresAt = now + (token.expires_in ?? 3600) * 1000;
    const { stored } = await ctx.runMutation(internal.googlePhotos.storeSession, {
      userId: claim.userId,
      state: args.state,
      sessionId: session.id,
      accessToken: token.access_token,
      pickerUri: session.pickerUri,
      pollIntervalMs: session.pollIntervalMs,
      expiresAt: Math.min(tokenExpiresAt, session.expiresAtMs),
    });
    if (!stored) {
      await google(`${GOOGLE_PICKER_API}/sessions/${session.id}`, {
        method: 'DELETE',
        token: token.access_token,
      });
      return { ok: false, reason: 'failed' };
    }
    return { ok: true, pickerUri: autoclosePickerUri(session.pickerUri) };
  },
});

// ── The page's side ──────────────────────────────────────────────────────────────────────────

/**
 * Internal: the caller's own session for a state, and whether the state is still waiting on
 * Google's consent. Reads the caller's identity (it runs from the page's actions), so one person
 * can never poll, list or fetch through another's session.
 */
export const callerSession = internalQuery({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const row = await ctx.db
      .query('photoPickerSessions')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (row && row.userId === profile._id && row.expiresAt >= Date.now()) {
      return { session: row, consenting: false };
    }
    const pending = await stateRow(ctx, args.state);
    return {
      session: null,
      consenting:
        pending !== null && pending.userId === profile._id && pending.expiresAt >= Date.now(),
    };
  },
});

/** Internal: record what the person picked, so a fetch can only name one of them. */
export const recordItems = internalMutation({
  args: {
    id: v.id('photoPickerSessions'),
    items: v.array(v.object({ id: v.string(), baseUrl: v.string(), mimeType: v.string() })),
  },
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { items: args.items });
  },
});

/** Internal: the session row is done with. */
export const deleteSession = internalMutation({
  args: { id: v.id('photoPickerSessions') },
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.delete(args.id);
  },
});

export type PickStatus =
  | { phase: 'consent'; pollIntervalMs: number }
  | { phase: 'picking'; pollIntervalMs: number }
  | { phase: 'picked' }
  | { phase: 'gone' };

/** While the person is still on Google's consent screen, look this often. */
const CONSENT_POLL_MS = 2_000;

/** Where the pick is: still consenting, still picking, picked, or gone (declined, expired, failed). */
export const status = action({
  args: { state: v.string() },
  handler: async (ctx, args): Promise<PickStatus> => {
    const { session, consenting } = await ctx.runQuery(internal.googlePhotos.callerSession, args);
    if (!session) {
      return consenting ? { phase: 'consent', pollIntervalMs: CONSENT_POLL_MS } : { phase: 'gone' };
    }
    const res = await google(`${GOOGLE_PICKER_API}/sessions/${session.sessionId}`, {
      token: session.accessToken,
    });
    if (!res?.ok) return { phase: 'gone' };
    const live = readPickerSession(await res.json(), Date.now());
    if (!live) return { phase: 'gone' };
    return live.mediaItemsSet
      ? { phase: 'picked' }
      : { phase: 'picking', pollIntervalMs: live.pollIntervalMs };
  },
});

/** What the page needs of a picked photo, before its bytes. */
export interface PickedMeta {
  id: string;
  takenAtMs?: number;
  filename: string;
}

/** The photos the person picked (photos only; at most the session's cap), recorded on the row. */
export const list = action({
  args: { state: v.string() },
  handler: async (ctx, args): Promise<PickedMeta[]> => {
    const { session } = await ctx.runQuery(internal.googlePhotos.callerSession, args);
    if (!session) throw new ConvexError('That Google Photos pick has ended — start again.');
    const picked: ReturnType<typeof readPickedPhotos>['photos'] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ sessionId: session.sessionId, pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await google(`${GOOGLE_PICKER_API}/mediaItems?${params}`, {
        token: session.accessToken,
      });
      if (!res?.ok) throw new ConvexError("Couldn't read what you picked — try again.");
      const page = readPickedPhotos(await res.json());
      picked.push(...page.photos);
      pageToken = page.nextPageToken;
    } while (pageToken && picked.length < GOOGLE_PICKER_MAX_ITEMS);
    const kept = picked.slice(0, GOOGLE_PICKER_MAX_ITEMS);
    await ctx.runMutation(internal.googlePhotos.recordItems, {
      id: session._id,
      items: kept.map((p) => ({ id: p.id, baseUrl: p.baseUrl, mimeType: p.mimeType })),
    });
    return kept.map((p) => ({
      id: p.id,
      filename: p.filename,
      ...(p.takenAtMs !== undefined ? { takenAtMs: p.takenAtMs } : {}),
    }));
  },
});

/** One picked photo's bytes at the full edge — returned to the page, never stored. */
export const photo = action({
  args: { state: v.string(), itemId: v.string() },
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; mimeType: string }> => {
    const { session } = await ctx.runQuery(internal.googlePhotos.callerSession, {
      state: args.state,
    });
    const item = session?.items?.find((i) => i.id === args.itemId);
    if (!session || !item) throw new ConvexError('That photo is not part of this pick.');
    const res = await google(sizedBaseUrl(item.baseUrl, FULL_EDGE), { token: session.accessToken });
    if (!res?.ok) throw new ConvexError("Couldn't fetch that photo from Google Photos.");
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_PHOTO_BYTES) throw new ConvexError('That photo is too large.');
    return { bytes, mimeType: res.headers.get('content-type') ?? item.mimeType };
  },
});

/** Done, or abandoned: delete the session at Google and its row here. Idempotent. */
export const close = action({
  args: { state: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { session } = await ctx.runQuery(internal.googlePhotos.callerSession, args);
    if (!session) return null;
    await google(`${GOOGLE_PICKER_API}/sessions/${session.sessionId}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    await ctx.runMutation(internal.googlePhotos.deleteSession, { id: session._id });
    return null;
  },
});

/** Cron: rows past their hour. Their token is dead at Google by then; the row goes too. */
export const pruneSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query('photoPickerSessions')
      .withIndex('by_expires_at', (q) => q.lt('expiresAt', Date.now()))
      .take(200);
    for (const row of stale) await ctx.db.delete(row._id);
    return { pruned: stale.length };
  },
});
