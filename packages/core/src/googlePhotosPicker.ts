/**
 * *From Google Photos* on the web (A10-8 §8.6, D207): the pure half of Google's Photos Picker API.
 * The Convex actions do the network; this decides what the consent asks for, reads what Google
 * answers, and refuses anything that is not a picked photo.
 *
 * The shape of the flow, since nothing else reads a Google library any more (the Library API's read
 * scopes answer 403 since 2025-03-31): consent for the one scope, a picker session, the person picks
 * **inside Google's UI**, the app polls the session until `mediaItemsSet`, then lists what was
 * picked and fetches each photo's bytes from its `baseUrl` with the bearer token. No token outlives
 * the session (`access_type=online`, no refresh token), so there is nothing to revoke or export.
 * A picked item carries its capture time and **no location**; Google strips location from the
 * bytes too, so a picked photo is never placed on the lake by itself (D42).
 */

/** The one scope — read what the person picked in the picker, nothing else. */
export const GOOGLE_PHOTOS_PICKER_SCOPE =
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_PICKER_API = 'https://photospicker.googleapis.com/v1';

/** How many photos one picking session may return — a skate's worth, and a bound on the fetches. */
export const GOOGLE_PICKER_MAX_ITEMS = 50;

/** The consent URL: the one scope, no refresh token, and the state that binds the flow. */
export function googlePhotosAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: GOOGLE_PHOTOS_PICKER_SCOPE,
    // Online: an access token for this hour and no refresh token — nothing kept, nothing to revoke.
    access_type: 'online',
    // Only this scope, never a sibling a past consent happened to grant.
    include_granted_scopes: 'false',
    state: args.state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Did the person grant the picker scope? Google's consent lets a person untick a scope, and a token
 * without it can create no session — better said at the callback than as a 403 from the picker.
 */
export function grantsPickerScope(scope: unknown): boolean {
  return typeof scope === 'string' && scope.split(/\s+/).includes(GOOGLE_PHOTOS_PICKER_SCOPE);
}

/**
 * A Google `Duration` (`"5s"`, `"3.5s"`, `"1800s"`) in ms, or `fallbackMs` when it is not one. The
 * picker says how often to poll and for how long; an unreadable answer falls back rather than
 * polling as fast as the loop can.
 */
export function googleDurationMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== 'string') return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!m) return fallbackMs;
  const ms = Math.round(Number(m[1]) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
}

/** A picker session as the app keeps it. */
export interface PickerSession {
  id: string;
  pickerUri: string;
  pollIntervalMs: number;
  /** When Google stops honoring the session, epoch ms. */
  expiresAtMs: number;
  mediaItemsSet: boolean;
}

/** The poll rate when Google does not say — its own documented default is a few seconds. */
export const PICKER_POLL_FALLBACK_MS = 5_000;

/** Read a `sessions.create` / `sessions.get` answer, or `null` when it is not one. */
export function readPickerSession(body: unknown, nowMs: number): PickerSession | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || typeof b.pickerUri !== 'string') return null;
  if (!b.pickerUri.startsWith('https://')) return null;
  const polling = (b.pollingConfig ?? {}) as Record<string, unknown>;
  const expire = typeof b.expireTime === 'string' ? Date.parse(b.expireTime) : Number.NaN;
  return {
    id: b.id,
    pickerUri: b.pickerUri,
    pollIntervalMs: googleDurationMs(polling.pollInterval, PICKER_POLL_FALLBACK_MS),
    expiresAtMs: Number.isFinite(expire)
      ? expire
      : nowMs + googleDurationMs(polling.timeoutIn, 30 * 60_000),
    mediaItemsSet: b.mediaItemsSet === true,
  };
}

/**
 * The picker page, closing itself once the person is done — Google's documented suffix for a
 * picker opened in its own window.
 */
export function autoclosePickerUri(pickerUri: string): string {
  return `${pickerUri.replace(/\/+$/, '')}/autoclose`;
}

/** One picked photo, as the app keeps it. */
export interface PickedPhoto {
  id: string;
  /** Capture time, epoch ms (Google's `createTime` is when the photo was taken, not uploaded). */
  takenAtMs?: number;
  baseUrl: string;
  mimeType: string;
  filename: string;
}

/**
 * The photos in a `mediaItems.list` page: `PHOTO`s only (a video is a later pass, §8.3), each with a
 * Google-hosted `https` `baseUrl` — the one thing the app will fetch with the person's token, so
 * nothing else is accepted.
 */
export function readPickedPhotos(body: unknown): { photos: PickedPhoto[]; nextPageToken?: string } {
  if (typeof body !== 'object' || body === null) return { photos: [] };
  const b = body as Record<string, unknown>;
  const items = Array.isArray(b.mediaItems) ? b.mediaItems : [];
  const photos: PickedPhoto[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== 'PHOTO' || typeof item.id !== 'string') continue;
    const file = (item.mediaFile ?? {}) as Record<string, unknown>;
    if (typeof file.baseUrl !== 'string' || !isGoogleMediaUrl(file.baseUrl)) continue;
    const taken = typeof item.createTime === 'string' ? Date.parse(item.createTime) : Number.NaN;
    photos.push({
      id: item.id,
      ...(Number.isFinite(taken) ? { takenAtMs: taken } : {}),
      baseUrl: file.baseUrl,
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'image/jpeg',
      filename:
        typeof file.filename === 'string' && file.filename ? file.filename : `${item.id}.jpg`,
    });
  }
  return {
    photos,
    ...(typeof b.nextPageToken === 'string' && b.nextPageToken
      ? { nextPageToken: b.nextPageToken }
      : {}),
  };
}

/** Is this a Google-hosted media URL? The bearer token goes to nothing else. */
export function isGoogleMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
}

/** A photo's bytes at most `edge` px on its long side — D31's full edge; Google does the scaling. */
export function sizedBaseUrl(baseUrl: string, edge: number): string {
  return `${baseUrl}=w${edge}-h${edge}`;
}
