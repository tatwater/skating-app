/**
 * Where an OAuth callback is allowed to send the browser (Phase 8).
 *
 * The callback in `convex/http.ts` is a **public, unauthenticated** endpoint that ends by putting a
 * caller-influenced string into a `Location:` header. That is the classic shape of an open redirect,
 * so the target is validated here rather than trusted — at both ends: when the connect flow mints its
 * state, and again when the callback consumes it.
 *
 * Three rules, in the order they matter:
 *
 * 1. **`http(s)` targets must match our own web origin.** Anything else is an open redirect — a link
 *    that looks like it goes to us and lands on someone else's site.
 * 2. **Non-web schemes are allowed.** A custom scheme (`skating://`, `exp://…` in a dev client) can
 *    only ever reach an app on the same device, and all it carries is a success/failure flag. An
 *    enumerated scheme allowlist would break in one of Expo Go / dev-client / production every time
 *    the packaging changes, which is how these checks end up quietly disabled.
 * 3. **No safe target ⇒ don't redirect at all.** Emitting a *relative* `Location` looks harmless but
 *    resolves against the Convex `.site` host, so the user lands on a 404 with no way back. A plain
 *    page saying what happened is a worse-looking but genuinely better outcome.
 *
 * The result flag is attached by parsing the URL, never by string concatenation: appending
 * `?strava=connected` to a target that already has a query silently produces `…?foo=1connected`.
 */

/** How a connect flow ended, as reported back to the app. */
export type OAuthResult = 'connected' | 'failed' | 'declined';

/** The query parameter the app reads to show the outcome. */
export const OAUTH_RESULT_PARAM = 'strava';

/**
 * Optional second parameter naming *why* a flow failed.
 *
 * It exists for one case that would otherwise be indistinguishable from a real OAuth error: the
 * browser-session cookie was missing (`session`). That's both the account-linking attack signature
 * and the cookies-are-blocked signature, and on a device the difference between "someone tried
 * something" and "this browser drops our cookie" is the difference between ignoring it and having a
 * bug to chase.
 */
export const OAUTH_REASON_PARAM = 'strava_reason';
export type OAuthFailureReason = 'session';

/**
 * May we redirect to `target`? See the module note — web targets are origin-locked, app schemes pass.
 * An unparseable target is refused: if we can't tell where it points, we don't send anyone there.
 */
export function isSafeOAuthRedirect(target: string, webAppUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false; // includes relative paths — those resolve against the wrong host (rule 3)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  if (!webAppUrl) return false;
  try {
    return parsed.origin === new URL(webAppUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Attach the result flag to a URL, replacing any existing value. Falls back to a manual append only
 * for targets `URL` can't parse — which `isSafeOAuthRedirect` has already excluded, so in practice
 * this is belt-and-braces for a caller that skipped the check.
 */
export function withOAuthResult(
  target: string,
  result: OAuthResult,
  reason?: OAuthFailureReason,
): string {
  try {
    const url = new URL(target);
    url.searchParams.set(OAUTH_RESULT_PARAM, result);
    if (reason) url.searchParams.set(OAUTH_REASON_PARAM, reason);
    return url.toString();
  } catch {
    const separator = target.includes('?') ? '&' : '?';
    const suffix = reason ? `&${OAUTH_REASON_PARAM}=${reason}` : '';
    return `${target}${separator}${OAUTH_RESULT_PARAM}=${result}${suffix}`;
  }
}

/** What the callback should do: bounce the browser somewhere, or render its own page. */
export type OAuthRedirectPlan =
  | { kind: 'redirect'; location: string }
  | { kind: 'page'; result: OAuthResult };

/**
 * Decide where a finished connect flow sends the browser.
 *
 * Prefers the target the flow started with (the app's deep link), falls back to the configured web
 * app, and renders a page when neither is usable — so the user is never dropped on a 404 and never
 * bounced to a stranger's domain.
 */
export function planOAuthRedirect(
  target: string | null | undefined,
  webAppUrl: string | undefined,
  result: OAuthResult,
  reason?: OAuthFailureReason,
): OAuthRedirectPlan {
  if (target && isSafeOAuthRedirect(target, webAppUrl)) {
    return { kind: 'redirect', location: withOAuthResult(target, result, reason) };
  }
  if (webAppUrl) {
    const fallback = `${webAppUrl.replace(/\/+$/, '')}/settings`;
    if (isSafeOAuthRedirect(fallback, webAppUrl)) {
      return { kind: 'redirect', location: withOAuthResult(fallback, result, reason) };
    }
  }
  return { kind: 'page', result };
}

/** Plain-language copy for the rendered fallback page — one line per outcome, no jargon. */
export const OAUTH_RESULT_COPY: Record<OAuthResult, { title: string; body: string }> = {
  connected: {
    title: 'Strava connected',
    body: 'You can close this window and go back to Skating.',
  },
  declined: {
    title: 'Strava not connected',
    body: "You didn't approve the connection, so nothing changed. You can close this window.",
  },
  failed: {
    title: "Couldn't connect Strava",
    body: 'Something went wrong connecting your account. Close this window and try again from the app.',
  },
};
