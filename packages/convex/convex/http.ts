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
 * trust a parameter to identify a user, and redirect rather than render (a bare error page in a
 * system browser is a dead end for someone standing on a frozen lake).
 *
 * Served from the deployment's `.convex.site` host — that URL is what goes in the Strava app's
 * "Authorization Callback Domain" setting.
 */

import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';

const http = httpRouter();

/** Where to land when a connect flow finishes and the state carried no redirect of its own. */
const DEFAULT_WEB_REDIRECT = '/settings?strava=';

/**
 * Strava's OAuth redirect target.
 *
 * Strava sends `code` + `state` on success, or `error=access_denied` when the athlete declines. Every
 * outcome ends in a redirect back into the app with a result flag, because the user is sitting in a
 * browser window they expect to close itself — an error page with a stack trace would strand them.
 */
http.route({
  path: '/strava/callback',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const declined = url.searchParams.get('error');

    const finish = (target: string | null, result: 'connected' | 'failed' | 'declined') => {
      const base = target ?? `${process.env.WEB_APP_URL ?? ''}${DEFAULT_WEB_REDIRECT}`;
      const location = base.includes('?') ? `${base}${result}` : `${base}?strava=${result}`;
      return new Response(null, { status: 302, headers: { Location: location } });
    };

    if (declined || !code || !state) return finish(null, declined ? 'declined' : 'failed');

    const outcome = await ctx.runAction(internal.strava.completeConnect, { code, state });
    return finish(outcome.redirectTo, outcome.ok ? 'connected' : 'failed');
  }),
});

export default http;
