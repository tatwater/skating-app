/**
 * **Browser-session binding for the OAuth connect flow** (Phase 8) — the cookie half of the state check.
 *
 * The `oauthStates` nonce answers *"has this callback been used before, and whose flow was it?"*. It
 * does **not** answer *"is the person who just approved on Strava the same person who started this?"*,
 * and that gap is a real attack: mint a state on your own account, get someone else to complete the
 * consent screen inside the TTL, and their Strava tokens land on your profile — an account-linking
 * takeover where the victim's account is the one that gets used.
 *
 * The standard defence is to bind the flow to the **browser session**, not just to a user id. So the
 * app no longer opens Strava's URL directly: it opens *our* `/strava/start`, which drops a cookie
 * carrying the nonce and then forwards to Strava. The callback requires that cookie to match the
 * `state` it was handed. An attacker cannot set a cookie in someone else's browser, so a victim's
 * consent arrives with no matching cookie and is refused **before any token exchange happens**.
 *
 * Why the cookie attributes are what they are:
 *  - **`SameSite=Lax` is required, and `Strict` would break this.** The callback is a cross-site
 *    top-level GET navigation from `strava.com`; `Lax` sends cookies on exactly that, `Strict` would
 *    withhold them and every connect would fail.
 *  - **`Path=/strava`** so it's never attached to any other request to the deployment.
 *  - **`HttpOnly` + `Secure`** — no script ever needs to read it, and the `.site` host is always HTTPS.
 *  - Both `/strava/start` and `/strava/callback` live on that same host, so this is a **first-party**
 *    cookie despite sitting in the middle of a cross-site OAuth dance.
 *
 * **This fails closed.** A browser that drops the cookie (private mode, aggressive tracking
 * prevention) can't connect. That's deliberate: a control you can switch off by clearing cookies is
 * not a control. The callback reports `reason=session` when it's the cookie that's missing, so a
 * device failure here is distinguishable from a genuine OAuth error rather than a mystery.
 */

/** The cookie carrying the in-flight connect nonce. */
export const OAUTH_STATE_COOKIE = 'skating_oauth_state';

/** Path the cookie is scoped to — it has no business on any other route. */
const COOKIE_PATH = '/strava';

/**
 * Build the `Set-Cookie` value that binds this browser to `state`.
 *
 * `maxAgeSeconds` should match the `oauthStates` TTL: a cookie that outlives its row is a cookie that
 * can only ever produce a confusing failure, and one that dies first breaks a legitimate slow login.
 */
export function serializeStateCookie(state: string, maxAgeSeconds: number): string {
  return [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/**
 * Build the `Set-Cookie` value that clears it. Sent once the flow ends, whatever the outcome — the
 * nonce is spent either way, and leaving it behind would only let a later stray callback look valid.
 */
export function clearStateCookie(): string {
  return [
    `${OAUTH_STATE_COOKIE}=`,
    `Path=${COOKIE_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/**
 * Read one cookie out of a `Cookie:` header. Returns `null` when the header is absent or the cookie
 * isn't in it.
 *
 * Deliberately tolerant of the shapes real browsers send — inconsistent spacing, a trailing
 * semicolon, values containing `=` — and deliberately strict about the name: a prefix match would let
 * `skating_oauth_state_decoy` satisfy a lookup for `skating_oauth_state`.
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // a malformed escape isn't worth failing the whole flow over
    }
  }
  return null;
}

/**
 * Does the browser presenting this `Cookie:` header own the flow that `state` belongs to?
 *
 * Both must be present and identical. An absent cookie is the attack signature *and* the
 * cookies-are-blocked signature — the caller distinguishes them for the user, not here.
 */
export function browserOwnsOAuthFlow(
  cookieHeader: string | null | undefined,
  state: string,
): boolean {
  if (!state) return false;
  const bound = readCookie(cookieHeader, OAUTH_STATE_COOKIE);
  return bound !== null && bound === state;
}
