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
import { type ActionCtx, httpAction } from './_generated/server';
import { ClerkWebhookError, type ClerkWebhookEvent, verifyClerkWebhook } from './lib/clerkWebhook';
import { OAUTH_STATE_TTL_SECONDS, stravaAuthorizeUrl } from './strava';

const http = httpRouter();

/**
 * Email unsubscribe (N8 PR 3 / D174). The link in every skater-facing email — and the
 * `List-Unsubscribe` header a mail client turns into its own button — lands here with no session.
 * The secret in `t` is the authorization and it authorizes one thing: the email channel goes off for
 * user `u`.
 *
 * **GET changes nothing.** Mail security scanners and link previewers fetch every URL in a message
 * before the person has seen it, so a GET that unsubscribed would silence people who never clicked.
 * The GET is a page with one button; the button POSTs. A mail client's own one-click button (RFC
 * 8058, `List-Unsubscribe-Post`) POSTs straight here and is answered with a bare 200, which is what
 * the RFC asks for; a browser submitting the form is told what happened.
 */
async function handleUnsubscribe(ctx: ActionCtx, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('u') ?? '';
  const secret = url.searchParams.get('t') ?? '';
  if (request.method !== 'POST') {
    // The form has no `action`, so it posts back to this same URL, query string included.
    return htmlPage(
      'Unsubscribe from Gli emails?',
      `<p>Gli will stop emailing you notifications. Your in-app notifications are unchanged, and you can turn email back on from Settings.</p>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`,
    );
  }
  const ok = await ctx.runMutation(internal.profiles.unsubscribeEmailBySecret, { userId, secret });
  const wantsPage = (request.headers.get('accept') ?? '').includes('text/html');
  if (!wantsPage) return new Response(null, { status: 200 });
  return ok
    ? htmlPage(
        'You’re unsubscribed',
        '<p>Gli won’t email you notifications any more. Your in-app notifications are unchanged, and you can turn email back on from Settings.</p>',
      )
    : htmlPage(
        'That link didn’t work',
        '<p>The link may be old, or already used. Email notifications can be turned off from Settings in the app.</p>',
      );
}

http.route({
  path: '/unsubscribe',
  method: 'GET',
  handler: httpAction(handleUnsubscribe),
});
http.route({
  path: '/unsubscribe',
  method: 'POST',
  handler: httpAction(handleUnsubscribe),
});

/**
 * Clerk's webhook (N8 post-merge / D174 amendment): `user.updated` keeps the email and avatar
 * mirrors on `profiles` current the moment they change, instead of at the person's next app open
 * (`profiles.syncFromClerk`). The case it exists for is the email channel's own user — someone who
 * changed their address and then didn't open the app for a season, still receiving the digest at
 * the old one.
 *
 * Verified before anything is read (`lib/clerkWebhook.ts`): a forged event here would redirect
 * private mail. The write is `profiles.applyClerkMirrors`, the same helper the launch-time sync
 * uses, so the two sources can't drift on the gate. Idempotent by construction (patch-if-different),
 * which is what Svix's retries need — a 2xx is "handled"; any other status is retried, for days.
 * Deliveries are not ordered either: two `user.updated` events for one person can arrive swapped.
 * That is what the event's `updated_at` is carried for — the helper refuses a write stamped older
 * than the row's `clerkUpdatedAt`, from this source or from a still-cached token on the other.
 *
 * `user.deleted` is acknowledged and not acted on. Our own finalization deletes the Clerk user
 * *after* the tombstone (`clerkAdmin.deleteUser`), so the ordinary arrival is for a row already
 * scrubbed. A deletion made in the Clerk dashboard for a live account is a founder action outside
 * the D62 lifecycle; it's logged so it can be noticed, and the profile is left for the lifecycle
 * to handle rather than half-erased from here.
 *
 * Registering the endpoint and its secret is per Clerk instance — see
 * `plans/05-accounts-and-credentials.md` §11b.
 */
http.route({
  path: '/clerk-webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    let event: ClerkWebhookEvent;
    try {
      event = await verifyClerkWebhook(request);
    } catch (err) {
      const status = err instanceof ClerkWebhookError ? err.status : 400;
      console.warn(`clerk-webhook rejected (${status}):`, err instanceof Error ? err.message : err);
      return new Response(null, { status });
    }
    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        await ctx.runMutation(internal.profiles.applyClerkMirrors, {
          clerkUserId: event.clerkUserId,
          email: event.email,
          profileImageUrl: event.profileImageUrl,
          ...(event.updatedAt !== null ? { updatedAt: event.updatedAt } : {}),
        });
        break;
      case 'user.deleted':
        console.log(
          `clerk-webhook: user.deleted for ${event.clerkUserId ?? '(no id)'} — not acted on`,
        );
        break;
      case 'ignored':
        break;
    }
    return new Response(null, { status: 200 });
  }),
});

/** Escape text destined for the fallback page's HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The one page shell this router serves — a real, phone-sized, dark-mode-aware page. `inner` is
 * HTML the caller has already escaped where it needs escaping; the title is escaped here.
 */
function htmlPage(title: string, inner: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2.5rem 1.5rem; color: #0f172a; background: #f8fafc; }
  main { max-width: 28rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; color: #475569; }
  button { font: inherit; padding: .6rem 1.2rem; border: 0; border-radius: .5rem; color: #fff; background: #0b69ff; }
  @media (prefers-color-scheme: dark) {
    body { color: #e2e8f0; background: #0f172a; }
    p { color: #94a3b8; }
  }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${inner}</main></body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * The last-resort page, shown when there is nowhere safe to send the browser (no deep link, no
 * configured web app). Deliberately a real page rather than a relative redirect: a relative
 * `Location` resolves against the Convex `.site` host, so it 404s and strands whoever is standing
 * there holding their phone.
 */
function resultPage(result: OAuthResult): Response {
  const copy = OAUTH_RESULT_COPY[result];
  return htmlPage(copy.title, `<p>${escapeHtml(copy.body)}</p>`);
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
