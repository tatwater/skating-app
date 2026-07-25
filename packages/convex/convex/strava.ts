/**
 * **C — Strava push** (Phase 8): upload a skater's own recorded activity to their own Strava account.
 *
 * This is the *only* legal direction. Strava's Nov-2024 API terms forbid displaying one athlete's
 * Strava data to any other user — even public data, even to no one but its owner's friends — and ban
 * AI/ML over it (L7). So we never **read** tracks from Strava; every path we draw came from our own
 * recorder. What we do here is the canonical complementary integration Strava explicitly permits and
 * that Garmin/Wahoo/COROS all do: write a user's own workout to their own account.
 *
 * It exists for adoption, not for data. A skater who has to choose between recording here and keeping
 * their Strava stats will choose Strava — so we remove the choice. **Record once, get both.**
 *
 * Three pieces:
 *  - **OAuth** (`beginConnect` → the `http.ts` callback → `completeConnect`), with the `state` nonce
 *    that binds an unauthenticated redirect back to a real user.
 *  - **Token refresh** — net-new for this repo; every other integration uses a static key, but Strava
 *    hands out 6-hour access tokens, so every upload has to be prepared to refresh first.
 *  - **Upload + poll** — `POST /uploads` is asynchronous: it returns an upload id, and the activity id
 *    appears seconds later. We poll, with a ceiling, and surface Strava's own error text (notably its
 *    duplicate rejection, which is the expected outcome when a watch already uploaded the same skate).
 *
 * Everything degrades quietly when `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` are unset — the same
 * posture `isochrones.ts` takes with `ORS_API_KEY`. A missing key disables the feature; it never
 * breaks a recording, because the activity is already ours the moment it's ingested.
 */

import { isSafeOAuthRedirect, type TrackPoint, toGpx } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { LineString } from 'geojson';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server';
import { requireProfile } from './lib/auth';

const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_UPLOAD_URL = 'https://www.strava.com/api/v3/uploads';
const STRAVA_ACTIVITY_URL = 'https://www.strava.com/api/v3/activities';

/**
 * `activity:write` to upload, `read` for the athlete identity we store as `externalUserId`.
 * Deliberately nothing more: we have no use for reading anyone's activities, and asking for a scope
 * we can't legally act on would be both misleading on the consent screen and pointless.
 */
const STRAVA_SCOPES = 'read,activity:write';

/** A connect nonce is single-use and short-lived — long enough to sign in to Strava, no longer. */
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/** Refresh a token this long before it actually expires, so an upload never races the boundary. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Strava's upload processing is usually < 2 s; poll at 1 s and give up well before an action times out. */
const UPLOAD_POLL_INTERVAL_MS = 1000;
const UPLOAD_POLL_MAX_ATTEMPTS = 20;

function stravaConfigured(): boolean {
  return Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect (OAuth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a connect flow: mint a single-use state nonce bound to the signed-in user, and return the URL
 * the app should open.
 *
 * **That URL is ours, not Strava's** — `/strava/start`, which sets the browser-session cookie and
 * *then* forwards to Strava. Handing out Strava's URL directly is what made the account-linking
 * attack possible: the nonce alone proves "some signed-in user began a flow", not "the person now
 * approving on Strava is that user". See `core/oauthSession.ts` for the full shape of that attack.
 */
export const beginConnect = mutation({
  args: { redirectTo: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);
    if (!stravaConfigured()) {
      throw new ConvexError('Strava is not configured on this deployment');
    }
    // Validate the return target here, at mint time, as well as in the callback: an unsafe target
    // should never reach the database in the first place, and rejecting it where the client supplies
    // it gives a real error instead of a silent fallback three redirects later.
    if (
      args.redirectTo !== undefined &&
      !isSafeOAuthRedirect(args.redirectTo, process.env.WEB_APP_URL)
    ) {
      throw new ConvexError('Unsafe redirect target');
    }
    const now = Date.now();
    // `crypto.randomUUID` is available in the Convex runtime; two of them make a nonce with far more
    // entropy than a guessing attack could cover inside the 15-minute window.
    const state = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
    await ctx.db.insert('oauthStates', {
      state,
      userId: profile._id,
      provider: 'strava',
      ...(args.redirectTo !== undefined ? { redirectTo: args.redirectTo } : {}),
      expiresAt: now + OAUTH_STATE_TTL_MS,
      createdAt: now,
    });

    // Our own start route — it binds the browser before anyone reaches Strava.
    return { connectUrl: `${process.env.CONVEX_SITE_URL}/strava/start?state=${state}` };
  },
});

/**
 * Strava's consent URL for a minted state. Built here (not in `beginConnect`) because only
 * `/strava/start` sends anyone there now, and having one construction site keeps the `redirect_uri`
 * we send from drifting away from the route that actually receives it.
 */
export function stravaAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID as string,
    redirect_uri: `${process.env.CONVEX_SITE_URL}/strava/callback`,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: STRAVA_SCOPES,
    state,
  });
  return `${STRAVA_AUTHORIZE_URL}?${params.toString()}`;
}

/** How long the browser-session cookie lives — the state TTL, in seconds. */
export const OAUTH_STATE_TTL_SECONDS = OAUTH_STATE_TTL_MS / 1000;

/**
 * Internal: does this state exist and is it still live? **Does not consume it** — `/strava/start`
 * runs before the user has even seen Strava's consent screen, so burning the nonce here would make
 * every flow fail at the callback. Only the callback consumes.
 */
export const peekOAuthState = internalQuery({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('oauthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row || row.expiresAt < Date.now()) return null;
    return { ok: true as const };
  },
});

/** Internal: consume a state nonce, returning whose flow it was. Single-use — deleted on read. */
export const consumeOAuthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('oauthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id); // single-use, whatever happens next
    if (row.expiresAt < Date.now()) return null;
    return { userId: row.userId, redirectTo: row.redirectTo ?? null };
  },
});

/** Internal: store (or replace) a user's Strava connection. Tokens are SERVER-ONLY, never returned. */
export const storeConnection = internalMutation({
  args: {
    userId: v.id('profiles'),
    externalUserId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = (
      await ctx.db
        .query('activityConnections')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect()
    ).find((c) => c.provider === 'strava');

    const fields = {
      userId: args.userId,
      provider: 'strava' as const,
      externalUserId: args.externalUserId,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: args.scopes,
      connectedAt: existing?.connectedAt ?? Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert('activityConnections', fields);
  },
});

/** The shape of Strava's token endpoint response (the fields we use). */
interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch SECONDS
  athlete?: { id: number };
}

/** Exchange an authorization code (or a refresh token) for a token pair. */
async function requestTokens(
  body: Record<string, string>,
): Promise<StravaTokenResponse | { error: string }> {
  try {
    const res = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        ...body,
      }),
    });
    if (!res.ok) return { error: `Strava token request failed: ${res.status}` };
    return (await res.json()) as StravaTokenResponse;
  } catch (err) {
    return { error: `Strava token request threw: ${String(err)}` };
  }
}

/**
 * Internal: finish the OAuth flow — called by the HTTP callback with the code + state.
 *
 * Returns where to send the browser, so the callback can bounce back into the app. A failure here is
 * returned rather than thrown: the user is sitting in a browser redirect, and an unhandled action
 * error would show them a bare error page instead of a "couldn't connect" screen in the app.
 */
export const completeConnect = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; redirectTo: string | null }> => {
    const claim = await ctx.runMutation(internal.strava.consumeOAuthState, { state: args.state });
    // No claim ⇒ unknown, expired, or already-used state. Refuse: this is exactly the replay the
    // nonce exists to stop, and there's no user to attribute the connection to anyway.
    if (!claim) return { ok: false, redirectTo: null };

    const tokens = await requestTokens({ code: args.code, grant_type: 'authorization_code' });
    if ('error' in tokens) {
      console.warn(tokens.error);
      return { ok: false, redirectTo: claim.redirectTo };
    }

    await ctx.runMutation(internal.strava.storeConnection, {
      userId: claim.userId,
      externalUserId: String(tokens.athlete?.id ?? ''),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: tokens.expires_at * 1000,
      scopes: STRAVA_SCOPES.split(','),
    });
    return { ok: true, redirectTo: claim.redirectTo };
  },
});

/** Internal: the stored connection for a user, tokens included (never exposed to a client). */
export const getConnection = internalQuery({
  args: { userId: v.id('profiles') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('activityConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    return rows.find((c) => c.provider === 'strava') ?? null;
  },
});

/**
 * Public: is this user connected to Strava? Deliberately returns **only** a boolean and the connect
 * time — the tokens on that row are server-only, and a query that returned the row wholesale would
 * hand a user's access token to their own client for no reason.
 */
export const connectionStatus = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    const rows = await ctx.db
      .query('activityConnections')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .collect();
    const strava = rows.find((c) => c.provider === 'strava');
    return {
      configured: stravaConfigured(),
      connected: strava !== undefined,
      connectedAt: strava?.connectedAt ?? null,
    };
  },
});

/** Disconnect: forget the tokens. We keep every track — they were always ours, not Strava's. */
export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    const rows = await ctx.db
      .query('activityConnections')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .collect();
    for (const row of rows.filter((c) => c.provider === 'strava')) await ctx.db.delete(row._id);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Push
// ─────────────────────────────────────────────────────────────────────────────

/** Internal: the activity data an upload needs, plus its owner, in one read. */
export const getActivityForUpload = internalQuery({
  args: { activityId: v.id('gpsActivities') },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) return null;
    const body = activity.waterBodyId ? await ctx.db.get(activity.waterBodyId) : null;
    return {
      userId: activity.userId,
      path: activity.path ?? null,
      startTime: activity.startTime,
      // Both carried because the GPX needs a *span*, not just an origin — see `pathToTrackPoints`.
      endTime: activity.endTime ?? null,
      elapsedSeconds: activity.elapsedSeconds ?? null,
      bodyName: body?.name ?? null,
    };
  },
});

/** A valid access token for `userId`, refreshing first if it's expired or about to be. */
async function accessTokenFor(ctx: ActionCtx, userId: Id<'profiles'>): Promise<string | null> {
  const connection = await ctx.runQuery(internal.strava.getConnection, { userId });
  if (!connection?.accessToken || !connection.refreshToken) return null;

  const expiresAt = connection.tokenExpiresAt ?? 0;
  if (expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) return connection.accessToken;

  // Refresh. This is net-new for this repo — every other integration uses a static key — and it's
  // why the upload path is an action: Strava access tokens live ~6 hours, so a track queued offline
  // for a week will *always* need one before it can be sent.
  const tokens = await requestTokens({
    grant_type: 'refresh_token',
    refresh_token: connection.refreshToken,
  });
  if ('error' in tokens) {
    console.warn(tokens.error);
    return null;
  }
  await ctx.runMutation(internal.strava.storeConnection, {
    userId,
    externalUserId: connection.externalUserId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: tokens.expires_at * 1000,
    scopes: connection.scopes ?? STRAVA_SCOPES.split(','),
  });
  return tokens.access_token;
}

/**
 * Turn a stored GeoJSON path back into the points the GPX emitter wants, spread evenly across the
 * activity's **real** span.
 *
 * Timestamps aren't stored per-coordinate (the path is geometry, not a time series), so the span has
 * to come from the row: Strava derives distance from the geometry but *duration and pace from the
 * timestamps*, so anything other than the recorded span posts a skate with the wrong elapsed time —
 * an hour on the ice arriving as twelve seconds. An even spread over the true span yields the correct
 * totals with a smoothed pace, which is honest for a track we post-processed anyway.
 *
 * `endTime` is preferred over `elapsedSeconds` because it *is* the elapsed span; `elapsedSeconds` is
 * moving time (pauses excluded) and so understates it. The 1 Hz fallback only catches rows predating
 * the field — both are optional in the schema.
 */
function pathToTrackPoints(
  path: LineString,
  startTime: number,
  endTime: number | null,
  elapsedSeconds: number | null,
): TrackPoint[] {
  const coords = path.coordinates;
  const span =
    endTime !== null && endTime > startTime
      ? endTime - startTime
      : elapsedSeconds !== null && elapsedSeconds > 0
        ? elapsedSeconds * 1000
        : (coords.length - 1) * 1000;
  const step = coords.length > 1 ? span / (coords.length - 1) : 0;
  return coords.map(([lng, lat, elevation], i) => ({
    lat: lat as number,
    lng: lng as number,
    t: Math.round(startTime + i * step),
    ...(typeof elevation === 'number' ? { elevation } : {}),
  }));
}

/**
 * Why a push didn't happen. The client needs this to tell "we never tried" from "Strava refused":
 * the first is a `skipped` track, the second a `failed` one, and the difference is what the skater
 * eventually sees. `duplicate` is a *success* wearing a failure's clothes — the activity is already
 * on Strava (a watch beat us to it), so there is nothing to retry and nothing to apologise for.
 */
export type StravaPushFailure =
  | 'not_configured'
  | 'not_signed_in'
  | 'not_connected'
  | 'not_found'
  | 'not_owner'
  | 'no_path'
  | 'too_short'
  | 'duplicate'
  | 'upload_failed';

interface UploadResult {
  ok: boolean;
  activityId?: number;
  error?: string;
  reason?: StravaPushFailure;
}

/**
 * Push one of the caller's own recorded skates to their own Strava.
 *
 * Owner-checked, obviously — but note the wider rule this enforces: there is no code path anywhere
 * that sends one user's track to another user's Strava, or that reads anything back from Strava into
 * a shared surface. The integration is strictly *your data → your account*.
 */
export const pushActivity = action({
  args: { activityId: v.id('gpsActivities') },
  handler: async (ctx, args): Promise<UploadResult> => {
    if (!stravaConfigured()) {
      return { ok: false, error: 'Strava is not configured', reason: 'not_configured' };
    }
    const profile = await ctx.runQuery(internal.strava.getPushProfile, {});
    if (!profile) return { ok: false, error: 'Not signed in', reason: 'not_signed_in' };

    const activity = await ctx.runQuery(internal.strava.getActivityForUpload, {
      activityId: args.activityId,
    });
    if (!activity) return { ok: false, error: 'Activity not found', reason: 'not_found' };
    if (activity.userId !== profile._id) {
      return { ok: false, error: 'Not your activity', reason: 'not_owner' };
    }
    if (activity.path?.type !== 'LineString') {
      return { ok: false, error: 'That skate has no recorded path', reason: 'no_path' };
    }

    const token = await accessTokenFor(ctx, profile._id);
    if (!token) return { ok: false, error: 'Strava is not connected', reason: 'not_connected' };

    const name = activity.bodyName ? `Skate on ${activity.bodyName}` : 'Ice skate';
    const gpx = toGpx(
      pathToTrackPoints(
        activity.path as LineString,
        activity.startTime,
        activity.endTime,
        activity.elapsedSeconds,
      ),
      { name, type: 'IceSkate' },
    );
    if (!gpx) {
      return { ok: false, error: 'That recording is too short to upload', reason: 'too_short' };
    }

    return await uploadAndPoll(token, gpx, name, String(args.activityId));
  },
});

/** Internal: the caller's profile, for the action (which has no db access of its own). */
export const getPushProfile = internalQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', identity.subject))
      .unique();
  },
});

/**
 * `POST /uploads` then poll `GET /uploads/{id}` until Strava finishes processing.
 *
 * The upload endpoint is **asynchronous**: it returns an upload id immediately and the activity id
 * appears a second or two later, so there's no way to confirm success without polling. `external_id`
 * carries our own activity id, which is what lets Strava recognise a re-send of the same skate and
 * reject it as a duplicate — and a duplicate rejection is a *success* from our side (the activity is
 * already on Strava), not something to retry.
 */
async function uploadAndPoll(
  token: string,
  gpx: string,
  name: string,
  externalId: string,
): Promise<UploadResult> {
  let uploadId: number;
  try {
    const form = new FormData();
    form.append('file', new Blob([gpx], { type: 'application/gpx+xml' }), 'skate.gpx');
    form.append('data_type', 'gpx');
    form.append('name', name);
    form.append('external_id', externalId);
    form.append('sport_type', 'IceSkate');

    const res = await fetch(STRAVA_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const body = (await res.json()) as { id?: number; error?: string; message?: string };
    if (!res.ok) return uploadError(body.message ?? body.error ?? `HTTP ${res.status}`);
    if (body.error) return uploadError(body.error);
    if (typeof body.id !== 'number') return uploadError('Strava returned no upload id');
    uploadId = body.id;
  } catch (err) {
    return uploadError(`Strava upload threw: ${String(err)}`);
  }

  for (let attempt = 0; attempt < UPLOAD_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, UPLOAD_POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${STRAVA_UPLOAD_URL}/${uploadId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as {
        activity_id?: number | null;
        error?: string | null;
        status?: string;
      };
      // Strava reports a duplicate here rather than at POST time. Surface it verbatim — it's the
      // expected outcome when a watch already uploaded this skate, and the caller treats it as
      // "nothing more to do" rather than as a failure worth retrying.
      if (body.error) return uploadError(body.error);
      if (typeof body.activity_id === 'number') {
        // GPX carries no formal sport vocabulary, so the type is set explicitly once the activity
        // exists — otherwise the skate lands as a generic workout.
        await setSportType(token, body.activity_id);
        return { ok: true, activityId: body.activity_id };
      }
    } catch (err) {
      return uploadError(`Strava poll threw: ${String(err)}`);
    }
  }
  return uploadError('Strava is still processing this upload');
}

/**
 * Classify one of Strava's own error strings. Only `duplicate` is special-cased, and only because
 * Strava has no error code to key off — its own wording ("duplicate of activity 123") is the signal,
 * and the outcome it implies (the skate is already up there) is the opposite of every other failure.
 */
function uploadError(error: string): UploadResult {
  return { ok: false, error, reason: /duplicate/i.test(error) ? 'duplicate' : 'upload_failed' };
}

/** Best-effort: stamp the activity as an ice skate. A failure here doesn't undo a successful upload. */
async function setSportType(token: string, activityId: number): Promise<void> {
  try {
    await fetch(`${STRAVA_ACTIVITY_URL}/${activityId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport_type: 'IceSkate' }),
    });
  } catch {
    // The activity is uploaded; its type being generic is cosmetic and the user can fix it.
  }
}

/** Sweep expired connect nonces. Cheap, bounded, and keeps a stale nonce from ever being usable. */
export const pruneOAuthStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query('oauthStates')
      .withIndex('by_expires_at', (q) => q.lt('expiresAt', Date.now()))
      .take(200);
    for (const row of stale) await ctx.db.delete(row._id);
    return { pruned: stale.length };
  },
});
