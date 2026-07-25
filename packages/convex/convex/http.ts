/**
 * The HTTP router — the **first** in this repo (Phase 8).
 *
 * Everything else the app does runs over Convex's client protocol, where a call carries a Clerk
 * identity. OAuth can't: the provider redirects a *browser* back to us, with no session and no way to
 * authenticate the request. That's the whole reason this file exists, and the whole reason
 * `oauthStates` exists alongside it — the `state` nonce is what turns an anonymous redirect back into
 * "this is Sam's connect flow".
 *
 * Endpoints here are public by definition. Treat every input as hostile: validate the state, never
 * trust a parameter to identify a user, and **never put an unvalidated string in a `Location:`
 * header** — that's an open redirect, and it's why the target goes through `planOAuthRedirect`
 * (`@skating/core`) rather than being interpolated here.
 *
 * Served from the deployment's `.convex.site` host — that URL is what goes in the Strava app's
 * "Authorization Callback Domain" setting.
 */

import {
  browserOwnsOAuthFlow,
  clearStateCookie,
  OAUTH_RESULT_COPY,
  type OAuthFailureReason,
  type OAuthResult,
  planOAuthRedirect,
  serializeStateCookie,
} from '@skating/core';
import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';
import { OAUTH_STATE_TTL_SECONDS, stravaAuthorizeUrl } from './strava';

const http = httpRouter();

/** Escape text destined for the fallback page's HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The last-resort page, shown when there is nowhere safe to send the browser (no deep link, no
 * configured web app). Deliberately a real page rather than a relative redirect: a relative
 * `Location` resolves against the Convex `.site` host, so it 404s and strands whoever is standing
 * there holding their phone.
 */
function resultPage(result: OAuthResult): Response {
  const copy = OAUTH_RESULT_COPY[result];
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(copy.title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2.5rem 1.5rem; color: #0f172a; background: #f8fafc; }
  main { max-width: 28rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #475569; }
  @media (prefers-color-scheme: dark) {
    body { color: #e2e8f0; background: #0f172a; }
    p { color: #94a3b8; }
  }
</style>
</head>
<body><main><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.body)}</p></main></body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * **Where a connect flow actually starts.** The app opens this, not Strava's URL.
 *
 * Its whole job is to bind the flow to *this browser* — drop the session cookie carrying the nonce,
 * then forward to Strava. Without this step the state nonce only proves "some signed-in user began a
 * flow", which lets an attacker mint a state on their own account and have a victim complete the
 * consent screen, landing the victim's Strava tokens on the attacker's profile. See
 * `core/oauthSession.ts`.
 *
 * The state is **peeked, not consumed** — the user hasn't seen Strava yet, and burning the nonce here
 * would make every legitimate flow fail at the callback.
 */
http.route({
  path: '/strava/start',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const state = new URL(request.url).searchParams.get('state');
    if (!state) return resultPage('failed');

    // An unknown or expired nonce never reaches Strava: no point sending someone through a consent
    // screen for a flow that cannot complete.
    const live = await ctx.runQuery(internal.strava.peekOAuthState, { state });
    if (!live) return resultPage('failed');

    return new Response(null, {
      status: 302,
      headers: {
        Location: stravaAuthorizeUrl(state),
        'Set-Cookie': serializeStateCookie(state, OAUTH_STATE_TTL_SECONDS),
      },
    });
  }),
});

/**
 * Strava's OAuth redirect target.
 *
 * Strava sends `code` + `state` on success, or `error=access_denied` when the athlete declines. Every
 * outcome ends somewhere intelligible — a deep link back into the app, our own web app, or the page
 * above — because the user is sitting in a browser window they expect to close itself.
 *
 * Before anything else, the **session check**: the `state` must match the cookie `/strava/start` set
 * in this browser. A mismatch is refused *before* the code is exchanged, so a victim's authorization
 * code is never traded for tokens. That failure reports `reason=session`, because "the cookie was
 * missing" is both the attack signature and the cookies-are-blocked signature, and on a real device
 * the difference matters.
 *
 * The cookie is cleared on every outcome — the nonce is spent either way.
 */
http.route({
  path: '/strava/callback',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const declined = url.searchParams.get('error');

    const finish = (target: string | null, result: OAuthResult, reason?: OAuthFailureReason) => {
      const plan = planOAuthRedirect(target, process.env.WEB_APP_URL, result, reason);
      const headers: Record<string, string> = { 'Set-Cookie': clearStateCookie() };
      if (plan.kind === 'page') {
        const page = resultPage(result);
        page.headers.set('Set-Cookie', headers['Set-Cookie'] as string);
        return page;
      }
      return new Response(null, { status: 302, headers: { ...headers, Location: plan.location } });
    };

    if (declined || !code || !state) return finish(null, declined ? 'declined' : 'failed');

    // The session binding, checked before the token exchange — see the note above.
    if (!browserOwnsOAuthFlow(request.headers.get('Cookie'), state)) {
      return finish(null, 'failed', 'session');
    }

    const outcome = await ctx.runAction(internal.strava.completeConnect, { code, state });
    return finish(outcome.redirectTo, outcome.ok ? 'connected' : 'failed');
  }),
});

export default http;
