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

/**
 * Masks the one path segment that names a person: `/u/<handle>` → `/u/:username` (D240).
 *
 * Path segments are otherwise kept, ids included (the founder call above) — lakes and reports are
 * places and documents, but a profile path is a person, and which person someone looked at is not
 * a question analytics needs to answer. Applied to every URL-valued property, `$pathname`
 * included. Exported for the test.
 */
export function maskProfilePath(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/\/u\/[^/?#]+/, '/u/:username');
}

/**
 * The URL-valued properties PostHog attaches on its own, including the `$set_once` initials. The
 * SDK also stamps the previous pageview's path on `$pageview`/`$pageleave`, and the session's entry
 * URL, path and referrer on **every** event — the copies a mask on `$current_url` alone would leave
 * naming the person (and carrying the query) one event later.
 */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$pathname',
  '$initial_current_url',
  '$initial_referrer',
  '$initial_pathname',
  '$prev_pageview_pathname',
  '$session_entry_url',
  '$session_entry_pathname',
  '$session_entry_referrer',
] as const;

/** Strip the query (credentials can ride in it), then mask the person-naming segment. */
function cleanUrlProperty(value: unknown): unknown {
  return maskProfilePath(stripUrlQuery(value));
}

/**
 * The `$pageview` dedupe's memory (D240): the last pageview's URL, stripped but **not** masked —
 * `/u/alice` → `/u/bob` must count as a navigation even though both mask to `/u/:username`.
 * Module state rather than anything stored: a hard reload starting fresh is correct, since the
 * reload's pageview is real. Exported reset for tests.
 */
let lastPageviewUrl: string | null = null;

export function resetPageviewDedupe(): void {
  lastPageviewUrl = null;
}

/**
 * Where `before_send` learns which route a pageview URL matches (D240). The router owns the
 * answer, and this module can't import the router (it configures PostHog before any router
 * exists), so `RouteAnalytics` injects a resolver at mount. Why `before_send` needs it at all:
 * the SDK's history hook fires on `pushState`, *before* the router finishes resolving, so the
 * `route_id` super-property registered on `onResolved` would stamp every pageview with the
 * *previous* route. Events captured by the app's own code (clicks, the typed taxonomy) happen
 * after resolution and the super-property is right for them.
 */
export type RouteIdResolver = (url: string) => string | null;

let routeIdResolver: RouteIdResolver | null = null;

export function setRouteIdResolver(resolver: RouteIdResolver | null): void {
  routeIdResolver = resolver;
}

/** One home for "which surface is this route" (§1.0): the console lives under `/admin`. */
export function surfaceForRouteId(routeId: string): 'admin' | 'skater' {
  return routeId === '/admin' || routeId.startsWith('/admin/') ? 'admin' : 'skater';
}

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

    if (event.event === '$pageview') {
      // One pageview per *page* (D240): `history_change` fires on every search-param change, so a
      // debounced `?q=`, a tab switch or `?post=` would each spam pageviews and wreck the funnels.
      // Those interactions carry their own typed events instead. Compared on the stripped,
      // unmasked URL: a path change (another lake, another person) is always a real navigation.
      const url = stripUrlQuery(event.properties.$current_url);
      if (typeof url === 'string') {
        if (url === lastPageviewUrl) return null;
        lastPageviewUrl = url;
      }
      // Stamp the *resolved* route onto the pageview — the registered super-property lags one
      // navigation behind on pageviews (see `setRouteIdResolver`).
      if (routeIdResolver && typeof event.properties.$current_url === 'string') {
        const routeId = routeIdResolver(event.properties.$current_url);
        if (routeId !== null) {
          event.properties.route_id = routeId;
          event.properties.surface = surfaceForRouteId(routeId);
        }
      }
    }

    // Every event says which deployment it came from, so one project can hold production,
    // preview and local traffic without a preview click sitting in a funnel beside a real
    // skater's. Done here rather than with `register()` because this runs on *every* event —
    // autocapture and pageviews included — with no init-order question to get wrong.
    event.properties.environment = env.deployEnvironment;

    // **No location derived from the IP, stated in code rather than trusted to the project.**
    //
    // PostHog's GeoIP transformation enriches events server-side with `$geoip_country_name`,
    // `$geoip_city_name` and — on an app whose notice promises coordinates are never sent —
    // `$geoip_latitude` / `$geoip_longitude`. It is on by default for a new cloud project, and
    // `anonymize_ips` does *not* stop it: PostHog's own docs say transformations still read the IP
    // before it is discarded. It has been disabled in the project, but that is a dashboard toggle,
    // and this integration's whole posture is that anything we rely on is pinned here instead —
    // the same rule as `capture_exceptions` and `capture_performance` above. The transformation
    // checks this property and returns early, so with it set the promise holds even if someone
    // switches the transformation back on.
    event.properties.$geoip_disable = true;

    for (const key of URL_PROPERTIES) {
      if (key in event.properties) event.properties[key] = cleanUrlProperty(event.properties[key]);
    }
    const setOnce = event.properties.$set_once;
    if (setOnce && typeof setOnce === 'object') {
      const once = setOnce as Record<string, unknown>;
      for (const key of URL_PROPERTIES) {
        if (key in once) once[key] = cleanUrlProperty(once[key]);
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
   * **Performance capture off — Sentry owns latency (D235).**
   *
   * Pinned rather than left unset, and that distinction is the whole point: this option's default
   * is `undefined`, which means *"fall back to the remote configuration"*. Left alone, switching
   * web vitals on in the PostHog project settings would start a second measurement of what
   * `browserTracingIntegration` already records at `tracesSampleRate: 1.0` — a duplicate arriving
   * through a dashboard toggle, with no diff and no review. Same shape as the replay lock above.
   */
  capture_performance: false,

  /**
   * **No exception capture — Sentry owns errors (D29/D235). `false`, never absent.**
   *
   * Absent is not off. The SDK reads `capture_exceptions: undefined` as *"ask the project's remote
   * config"* — `isUndefined(config.capture_exceptions) ? remote : config.capture_exceptions` — so
   * leaving the option out hands the decision to a dashboard toggle. `false` is the only value
   * that actually settles it, and `stopExceptionAutocapture()` sets exactly that.
   *
   * Why it has to be settled: PostHog's capture is an independent `window.onerror` /
   * `unhandledrejection` hook. It shares nothing with Sentry's pipeline, so it never passes
   * through `sentryPrivacyHooks.beforeSend` → `redactSentryEvent` in `@skating/core`, which is
   * what strips coordinates, a home location, a date of birth, a bio and connected-account
   * credentials out of an error before it leaves the browser. `before_send` above only rewrites
   * URL properties, so an exception *message* carrying a coordinate would reach PostHog verbatim
   * while Sentry's copy of the same error arrived redacted — one error, two processors, two
   * privacy postures, and the weaker one invisible from the Sentry side.
   *
   * The correlation this gives up ("which funnel step was the person on when it broke") is
   * available the other way round and for free: `posthog-js` ships `sentryIntegration()`, a Sentry
   * event processor that tags Sentry events with a link to the PostHog person. If that is ever
   * wired, note that Sentry runs event processors *before* `beforeSend`, so its
   * `sendExceptionsToPostHog` default of `true` would hand PostHog `$sentry_exception` and
   * `$sentry_tags` un-redacted — strictly worse than what this option refuses.
   */
  capture_exceptions: false,

  /**
   * **Features that would put someone else's UI on a safety surface, all switched off.**
   *
   * Surveys, product tours and conversations each render PostHog-authored content inside the app,
   * and each is *enabled* by SDK default (`disable_*: false`) with the dashboard deciding whether
   * anything actually shows. On this app that is a D3 problem before it is a taste problem: copy
   * that nobody here wrote, appearing over a map of ice conditions, cannot be held to "peer
   * observation, never a guarantee" — and it would arrive with no diff, no review and no release.
   *
   * Web experiments are worse in kind, because they mutate the DOM from the dashboard. They
   * default off today, but the SDK's own note says that default is temporary ("currently disabled
   * while we're in BETA"), so inheriting it is borrowing a value the vendor has said it will
   * change. Stated here, it cannot move under us.
   *
   * None of these is a feature this app uses, so turning them off costs nothing and removes a
   * whole class of remote change.
   */
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,

  /**
   * Heatmaps off, for the `capture_performance` reason: `capture_heatmaps` defaults to `undefined`,
   * so it defers to the dashboard, and it collects pointer coordinates — which on a map-heavy app
   * tell you almost nothing anyway.
   */
  capture_heatmaps: false,

  /**
   * Autocapture **stays on** (founder call) — an object here configures it, it does not disable
   * it. The one sub-setting stated is clipboard capture: what someone lifted off a report or a
   * hazard note is content, not shape, and the SDK reads this flag out of the *remote* autocapture
   * config when it is not set locally.
   *
   * Honest limit: this is a statement of intent rather than a proven lock. The SDK merges remote
   * autocapture settings over the local ones, and unlike `capture_exceptions` and
   * `capture_performance` the merge order here was not verified. If clipboard events ever show up
   * in PostHog despite this, that is the reason, and `before_send` is the place to drop them.
   */
  autocapture: { capture_copied_text: false },

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
