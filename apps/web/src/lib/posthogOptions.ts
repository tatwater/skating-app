import type { CaptureResult, PostHogConfig } from 'posthog-js';
import { env } from './env';

/**
 * PostHog browser options (D29 / D235) — the analytics half of observability, the way
 * `sentryOptions.ts` is the error half.
 *
 * One exported object rather than an options literal inlined in the provider, for the reason
 * `sentryOptions.ts` gives: the privacy-relevant switches are the ones nobody notices have
 * drifted until private data is already collected, so they live somewhere a test can read them.
 * The companion test guards the ones that matter — the session-replay lock above all — and fails
 * if any is quietly flipped.
 */

/**
 * Strips the query string and fragment from a URL, keeping scheme, host and path.
 *
 * `$current_url` and `$referrer` ride on every automatic event — pageviews, autocaptured clicks,
 * exceptions — and a query string on this app can carry Clerk's `__clerk_db_jwt` handoff parameter
 * in development, which is a credential. `sentryOptions.ts` refuses the same category with
 * `urlQueryParams: false`; this is the analytics half of that rule.
 *
 * Path segments are deliberately **kept**, including the ids in them (founder call): which lakes
 * and reports draw traffic is a question worth being able to ask, and the paths are not
 * credentials. Exported for the test.
 */
export function stripUrlQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // Not `new URL()`: `$pathname` and `$referrer` are not always absolute, and a parse failure
  // must not drop the property. Cutting at the first `?` or `#` is correct for both shapes.
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** The URL-valued properties PostHog attaches on its own, including the `$set_once` initials. */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
] as const;

export const posthogOptions = {
  /**
   * PostHog's US ingestion host, cross-origin on purpose — see `env.ts` for why the same-origin
   * proxy was reversed (it would send Clerk's session cookie to PostHog on every event).
   */
  api_host: env.posthogHost,

  /**
   * Drops query strings from the URLs PostHog attaches by itself. The ten hand-written events
   * carry no URL at all, so this is the only path by which one arrives.
   */
  before_send: (event: CaptureResult | null): CaptureResult | null => {
    if (!event?.properties) return event;
    for (const key of URL_PROPERTIES) {
      if (key in event.properties) event.properties[key] = stripUrlQuery(event.properties[key]);
    }
    const setOnce = event.properties.$set_once;
    if (setOnce && typeof setOnce === 'object') {
      const once = setOnce as Record<string, unknown>;
      for (const key of URL_PROPERTIES) {
        if (key in once) once[key] = stripUrlQuery(once[key]);
      }
    }
    return event;
  },

  /**
   * **Session replay is off, and this line is the one L12 turns on.**
   *
   * D29 settled the shape before any of this was wired: replay ships OFF, and when it is
   * eventually enabled it is *never* recorded for `isMinor` users, starts only after the profile
   * resolves, and runs with input and location masking. None of that is built, because none of it
   * is cleared — L12 is ⛔ pending the legal pass (Q10), and `PRIVACY.md` tells users in writing
   * that replay "will never record users under 18".
   *
   * So recording is disabled *at init*, which is stricter than leaving it to the project's
   * server-side setting: a toggle in the PostHog dashboard cannot start recording a session that
   * the client never armed. Turning replay on is therefore a code change that has to come through
   * review, which is the correct amount of friction for the one feature on this integration that
   * can capture a 17-year-old's screen.
   *
   * Do not flip this to `false` without: L12 cleared, the `isMinor` gate built, masking
   * configured, and `PRIVACY.md` updated.
   */
  disable_session_recording: true,

  /**
   * **`capture_exceptions` is deliberately absent. Do not add it.**
   *
   * Sentry owns errors — D29 says so in as many words, and PostHog's own exception capture would
   * be a second copy of every uncaught error with none of the protection the first copy gets.
   * That is the part worth stating, because the duplication is the lesser problem:
   *
   * PostHog's capture is an independent `window.onerror` / `unhandledrejection` hook. It shares
   * nothing with Sentry's pipeline, so it never passes through `sentryPrivacyHooks.beforeSend` →
   * `redactSentryEvent` in `@skating/core`, which is what strips coordinates, a home location, a
   * date of birth, a bio and connected-account credentials out of an error before it leaves the
   * browser. `before_send` above only rewrites URL properties, so an exception *message* carrying
   * a coordinate would go to PostHog verbatim while Sentry's copy of the same error arrived
   * redacted — one error, two processors, two different privacy postures, and the weaker one
   * invisible from the Sentry side.
   *
   * The correlation this gave up ("which funnel step was the person on when it broke") is
   * available the other way round and for free: `posthog-js` ships `sentryIntegration()`, a Sentry
   * event processor that tags Sentry events with a link to the PostHog person. If that is ever
   * wired, note that Sentry runs event processors *before* `beforeSend`, so its
   * `sendExceptionsToPostHog` default of `true` would hand PostHog `$sentry_exception` and
   * `$sentry_tags` un-redacted — strictly worse than what this comment removed. It has to be
   * `false`.
   */

  /**
   * Opts into PostHog's 2025-05-24 defaults, whose two material effects here are
   * `person_profiles: 'identified_only'` — anonymous traffic produces events but no person record,
   * which is both cheaper and less data held — and SPA-aware pageviews, which the next option
   * states explicitly rather than inheriting.
   */
  defaults: '2025-05-24',

  /**
   * Pageviews on history changes, not just on hard loads. TanStack Router navigates without a
   * document load, so the default would have recorded one pageview per session and every funnel
   * built on "which surfaces do skaters touch" would have been wrong.
   */
  capture_pageview: 'history_change',

  /** SDK console diagnostics in development only. */
  debug: import.meta.env.DEV,
} as const satisfies Partial<PostHogConfig>;
