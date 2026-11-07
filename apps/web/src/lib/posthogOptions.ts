import type { PostHogConfig } from 'posthog-js';
import { env } from './env';

/**
 * PostHog browser options (D29 / D235) — the analytics half of observability, the way
 * `sentryOptions.ts` is the error half.
 *
 * One exported object rather than an options literal inlined in `__root.tsx`, for the reason
 * given there: the privacy-relevant switches are the ones nobody notices have drifted until
 * private data is already collected, so they live somewhere a test can read them. The companion
 * test asserts the two that matter most ({@link posthogOptions.disable_session_recording} and the
 * proxy host) and will fail if either is ever quietly flipped.
 */
export const posthogOptions = {
  /**
   * Same-origin by default (`/rink`, rewritten in `vercel.json`) — see `env.posthogHost`.
   */
  api_host: env.posthogHost,

  /**
   * Where PostHog's *own* UI lives, so links the SDK generates point at the app and not at the
   * proxy path. Separate from `api_host` precisely because the proxy makes them differ.
   */
  ui_host: env.posthogUiHost,

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
   * Uncaught browser exceptions go to PostHog as well as Sentry (D29 keeps both: Sentry owns error
   * quality and grouping, PostHog correlates a crash with the funnel the person was in). Sentry
   * remains the thing that pages us; this is context, not a second alerting path.
   */
  capture_exceptions: true,

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
