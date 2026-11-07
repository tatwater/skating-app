import { describe, expect, it } from 'vitest';
import { env } from './env';
import {
  maskProfilePath,
  posthogOptions,
  resetPageviewDedupe,
  setRouteIdResolver,
  stripUrlQuery,
  surfaceForRouteId,
} from './posthogOptions';

/**
 * Deliberately **unmocked** `./env`. An earlier version of this file stubbed the host and then
 * asserted the stub, which meant the ingestion guard below could not fail: changing the real
 * default in `env.ts` left the suite green. These read the shipped values.
 */

/**
 * These are regression guards on privacy-relevant configuration, not a restatement of the module
 * (D29/D235). Each one is here because flipping it is a one-word edit whose consequence lives
 * somewhere the diff doesn't show.
 */
describe('posthogOptions', () => {
  /**
   * **The L12 guard.** D29 settled that session replay ships off and is never recorded for
   * `isMinor` users; L12 is still ⛔ pending the legal pass, and `PRIVACY.md` tells users in
   * writing that replay "will never record users under 18". None of the minor gating or masking
   * that promise requires is built, so the only honest state is disabled at init.
   *
   * If this test fails, the question is not "update the test" — it is whether L12 cleared, the
   * `isMinor` gate exists, masking is configured, and `PRIVACY.md` was updated.
   */
  it('disables session recording at init', () => {
    expect(posthogOptions.disable_session_recording).toBe(true);
  });

  /**
   * Disabling at init, rather than relying on the project's server-side recording toggle, is what
   * makes the guard above hold: a dashboard switch cannot start a recorder the client never armed.
   * So the option must be *present*, not merely falsy by omission.
   */
  it('states the recording switch explicitly rather than leaving it to the remote default', () => {
    expect(Object.hasOwn(posthogOptions, 'disable_session_recording')).toBe(true);
  });

  /**
   * Cross-origin on purpose (D235). A **same-origin** host is the thing to catch here: `fetch`
   * defaults to `credentials: 'same-origin'` and `posthog-js` sets no override, so a relative
   * `api_host` would attach this app's cookies — Clerk's `__session` among them — to every
   * ingestion request. That is what reversed the proxy, and this is what keeps it reversed.
   */
  it('sends ingestion to an absolute cross-origin host, never a same-origin path', () => {
    expect(posthogOptions.api_host).toBe('https://us.i.posthog.com');
    expect(posthogOptions.api_host.startsWith('/')).toBe(false);
    expect(new URL(posthogOptions.api_host).origin).toBe('https://us.i.posthog.com');
  });

  /** The default is the shipped one, not something a test supplied. */
  it('takes its host from env, which defaults to PostHog rather than to this app', () => {
    expect(posthogOptions.api_host).toBe(env.posthogHost);
  });

  /** SPA navigations are the only navigations this app performs after first load. */
  it('captures pageviews on history changes, which is how a router-driven app navigates', () => {
    expect(posthogOptions.capture_pageview).toBe('history_change');
  });

  /**
   * **The error-ownership guard.** Sentry owns errors (D29), and PostHog's exception capture is not
   * merely a duplicate: it is an independent `window.onerror` hook that never passes through
   * `redactSentryEvent`, so it would send an exception message carrying a coordinate or a home
   * location verbatim while Sentry's copy of the same error arrived redacted.
   *
   * Asserted present **and** `false`. An earlier version of this test asserted the key was
   * *absent*, on the reasoning that absent and `false` behave alike — which is true of an ordinary
   * option and false of this one: the SDK reads `undefined` as "ask the project's remote config",
   * so absence hands the decision to a dashboard toggle. Absence is the bug here, not the fix.
   */
  it('pins exception capture off — Sentry owns errors, with the redaction to match', () => {
    expect(Object.hasOwn(posthogOptions, 'capture_exceptions')).toBe(true);
    expect(posthogOptions.capture_exceptions).toBe(false);
  });

  /**
   * Surveys, product tours and conversations each render PostHog-authored UI inside the app and
   * are *enabled* by SDK default, with the dashboard deciding whether anything shows. Copy nobody
   * here wrote, over a map of ice conditions, is a D3 problem arriving with no diff and no review.
   * Web experiments mutate the DOM from the dashboard; they default off, but the SDK says that
   * default is temporary, so it is stated rather than inherited.
   */
  it.each([
    'disable_surveys',
    'disable_product_tours',
    'disable_conversations',
    'disable_web_experiments',
  ] as const)('switches off %s, so no remote change can render UI in the app', (key) => {
    expect(Object.hasOwn(posthogOptions, key)).toBe(true);
    expect(posthogOptions[key]).toBe(true);
  });

  /** Pointer coordinates defer to remote config when unset, and tell us little on a map. */
  it('pins heatmap capture off', () => {
    expect(Object.hasOwn(posthogOptions, 'capture_heatmaps')).toBe(true);
    expect(posthogOptions.capture_heatmaps).toBe(false);
  });

  /**
   * Autocapture stays on — the object configures it rather than disabling it — and says no to
   * clipboard capture, since what someone lifted off a report is content rather than shape.
   */
  it('keeps autocapture on while refusing clipboard capture', () => {
    expect(posthogOptions.autocapture).not.toBe(false);
    expect(posthogOptions.autocapture).toMatchObject({ capture_copied_text: false });
  });

  /** `identified_only` person profiles ride on this; losing it would create a person per visitor. */
  it('opts into the dated defaults rather than drifting with the SDK', () => {
    expect(posthogOptions.defaults).toBe('2025-05-24');
  });

  /**
   * **The other remote-config lock.** `capture_performance`'s default is `undefined`, which means
   * "ask the PostHog project settings" — so leaving it unset lets a dashboard toggle start a
   * second measurement of what Sentry's `browserTracingIntegration` already records at
   * `tracesSampleRate: 1.0`. Pinned `false`, it cannot. Asserted as present *and* false, because
   * absence here is the failure, not the fix.
   */
  it('pins performance capture off rather than deferring it to the dashboard', () => {
    expect(Object.hasOwn(posthogOptions, 'capture_performance')).toBe(true);
    expect(posthogOptions.capture_performance).toBe(false);
  });
});

/**
 * Query strings carry Clerk's `__clerk_db_jwt` handoff parameter in development, which is a
 * credential; `sentryOptions.ts` refuses the whole category with `urlQueryParams: false`. Path
 * segments stay, ids included — a founder call, so that which lakes draw traffic is still askable.
 */
describe('stripUrlQuery', () => {
  it('drops a query string and keeps scheme, host and path', () => {
    expect(stripUrlQuery('https://gli.app/report/abc123?__clerk_db_jwt=secret')).toBe(
      'https://gli.app/report/abc123',
    );
  });

  it('drops a fragment', () => {
    expect(stripUrlQuery('https://gli.app/lake/xyz#hazards')).toBe('https://gli.app/lake/xyz');
  });

  it('keeps the id segments in a path', () => {
    expect(stripUrlQuery('https://gli.app/u/teagan/report/r_1')).toBe(
      'https://gli.app/u/teagan/report/r_1',
    );
  });

  it('leaves a clean URL and a bare path untouched', () => {
    expect(stripUrlQuery('https://gli.app/feed')).toBe('https://gli.app/feed');
    expect(stripUrlQuery('/lake/xyz')).toBe('/lake/xyz');
  });

  /** A property PostHog did not set, or set to something that is not a string, must survive. */
  it('passes non-strings through rather than dropping the property', () => {
    expect(stripUrlQuery(undefined)).toBeUndefined();
    expect(stripUrlQuery(null)).toBeNull();
    expect(stripUrlQuery(42)).toBe(42);
  });
});

describe('before_send', () => {
  const send = (properties: Record<string, unknown>) =>
    // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
    posthogOptions.before_send({ properties } as any)?.properties;

  it('scrubs every URL property PostHog attaches on its own', () => {
    expect(
      send({
        $current_url: 'https://gli.app/feed?__clerk_db_jwt=secret',
        $referrer: 'https://gli.app/u/teagan?tab=reports',
      }),
    ).toMatchObject({
      $current_url: 'https://gli.app/feed',
      // Query stripped *and* the person-naming segment masked (D240).
      $referrer: 'https://gli.app/u/:username',
    });
  });

  it('scrubs the previous-pageview path and the session-entry copies the SDK stamps on', () => {
    expect(
      send({
        $prev_pageview_pathname: '/u/teagan',
        $session_entry_url: 'https://gli.app/u/teagan?__clerk_ticket=tok',
        $session_entry_pathname: '/u/teagan',
        $session_entry_referrer: 'https://gli.app/u/kate?tab=reports',
      }),
    ).toMatchObject({
      $prev_pageview_pathname: '/u/:username',
      $session_entry_url: 'https://gli.app/u/:username',
      $session_entry_pathname: '/u/:username',
      $session_entry_referrer: 'https://gli.app/u/:username',
    });
  });

  it('masks the profile segment in $pathname while keeping lake and report ids (D240)', () => {
    expect(
      send({
        $pathname: '/u/teagan',
        $current_url: 'https://gli.app/water/body123?tab=weather',
      }),
    ).toMatchObject({
      $pathname: '/u/:username',
      $current_url: 'https://gli.app/water/body123',
    });
  });

  /** `$set_once` holds the first-touch copies, which outlive the event they arrived on. */
  it('scrubs the first-touch URLs inside $set_once', () => {
    const out = send({
      $set_once: {
        $initial_current_url: 'https://gli.app/?__clerk_db_jwt=secret',
        $initial_referrer: 'https://example.com/x?utm_source=y',
      },
    });
    expect(out?.$set_once).toEqual({
      $initial_current_url: 'https://gli.app/',
      $initial_referrer: 'https://example.com/x',
    });
  });

  /** Our own properties pass through untouched; the environment stamp is the only addition. */
  it("leaves the app's own event properties alone", () => {
    const out = send({ hazard_type: 'pressure_ridge', photo_count: 2 });

    expect(out).toMatchObject({ hazard_type: 'pressure_ridge', photo_count: 2 });
    expect(Object.keys(out ?? {}).sort()).toEqual([
      '$geoip_disable',
      'environment',
      'hazard_type',
      'photo_count',
    ]);
  });

  it('passes a dropped event and a property-less event through without throwing', () => {
    expect(posthogOptions.before_send(null)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
    expect(() => posthogOptions.before_send({} as any)).not.toThrow();
  });
});

describe('maskProfilePath', () => {
  it('masks the handle wherever the segment sits', () => {
    expect(maskProfilePath('/u/teagan')).toBe('/u/:username');
    expect(maskProfilePath('https://gli.app/u/teagan')).toBe('https://gli.app/u/:username');
  });

  it('leaves every other path alone, ids included (the founder call)', () => {
    expect(maskProfilePath('/water/body123')).toBe('/water/body123');
    expect(maskProfilePath('/report/r_1')).toBe('/report/r_1');
    expect(maskProfilePath('https://gli.app/latest')).toBe('https://gli.app/latest');
  });

  it('passes non-strings through', () => {
    expect(maskProfilePath(undefined)).toBeUndefined();
    expect(maskProfilePath(7)).toBe(7);
  });
});

/**
 * `history_change` fires a pageview on every search-param navigation, so a debounced `?q=`, a tab
 * switch or `?post=` would each spam pageviews and wreck the funnels (D240). One pageview per
 * page: the dedupe compares the stripped URL, so a param-only change drops and a path change
 * never does.
 */
describe('the $pageview dedupe', () => {
  const pageview = (url: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
    posthogOptions.before_send({ event: '$pageview', properties: { $current_url: url } } as any);

  it('drops a search-param-only navigation and keeps a path change', () => {
    resetPageviewDedupe();
    expect(pageview('https://gli.app/water/a?tab=reports')).not.toBeNull();
    expect(pageview('https://gli.app/water/a?tab=weather')).toBeNull();
    expect(pageview('https://gli.app/water/a?tab=about')).toBeNull();
    expect(pageview('https://gli.app/water/b?tab=reports')).not.toBeNull();
    // Coming back is a navigation again.
    expect(pageview('https://gli.app/water/a')).not.toBeNull();
  });

  it('counts one person’s profile to another as a navigation despite both masking alike', () => {
    resetPageviewDedupe();
    expect(pageview('https://gli.app/u/alice')).not.toBeNull();
    expect(pageview('https://gli.app/u/bob')).not.toBeNull();
  });

  it('never dedupes the other event kinds', () => {
    resetPageviewDedupe();
    const send = (url: string) =>
      posthogOptions.before_send({
        event: '$autocapture',
        properties: { $current_url: url },
        // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
      } as any);
    expect(send('https://gli.app/latest')).not.toBeNull();
    expect(send('https://gli.app/latest')).not.toBeNull();
  });
});

/**
 * Pageviews are stamped with the route the URL *resolves to*, asked of the router through the
 * injected resolver — the registered super-property lags one navigation behind on pageviews
 * because the SDK's history hook runs before the router finishes (D240).
 */
describe('the route stamp on pageviews', () => {
  const pageview = (url: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
    posthogOptions.before_send({ event: '$pageview', properties: { $current_url: url } } as any);

  it('stamps route_id and surface when a resolver is installed', () => {
    resetPageviewDedupe();
    setRouteIdResolver((url) => (url.includes('/admin') ? '/admin/users' : '/_skater/latest'));
    try {
      const skater = pageview('https://gli.app/latest');
      expect(skater?.properties).toMatchObject({
        route_id: '/_skater/latest',
        surface: 'skater',
      });
      const admin = pageview('https://gli.app/admin/users');
      expect(admin?.properties).toMatchObject({ route_id: '/admin/users', surface: 'admin' });
    } finally {
      setRouteIdResolver(null);
    }
  });

  it('sends the pageview unstamped when no resolver is installed or it has no answer', () => {
    resetPageviewDedupe();
    expect(pageview('https://gli.app/latest')?.properties?.route_id).toBeUndefined();
    setRouteIdResolver(() => null);
    try {
      resetPageviewDedupe();
      expect(pageview('https://gli.app/latest')?.properties?.route_id).toBeUndefined();
    } finally {
      setRouteIdResolver(null);
    }
  });
});

describe('surfaceForRouteId', () => {
  it('puts the console under /admin and everything else with the skaters (§1.0)', () => {
    expect(surfaceForRouteId('/admin')).toBe('admin');
    expect(surfaceForRouteId('/admin/users/$id')).toBe('admin');
    expect(surfaceForRouteId('/_skater/latest')).toBe('skater');
    expect(surfaceForRouteId('/_map/water/$id')).toBe('skater');
    expect(surfaceForRouteId('/sign-in')).toBe('skater');
    // A route merely *naming* admin is not the console.
    expect(surfaceForRouteId('/administrivia')).toBe('skater');
  });
});

/**
 * One PostHog project holds production, preview and local traffic, so every event has to say which
 * it came from — otherwise a preview click sits in a funnel beside a real skater's, unfilterable.
 */
describe('the environment stamp', () => {
  const send = (properties: Record<string, unknown>) =>
    // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
    posthogOptions.before_send({ properties } as any)?.properties;

  it('stamps every event with the deployment it came from', () => {
    expect(send({})?.environment).toBe(env.deployEnvironment);
  });

  /** Under test there is no Vercel and no `.env`, which is what `development` is the answer for. */
  it('falls back to development when nothing injected a deployment', () => {
    expect(env.deployEnvironment).toBe('development');
  });

  /**
   * The project's GeoIP transformation is disabled, but that is a dashboard toggle and this
   * integration pins what it relies on. The transformation honours this property by returning
   * early, so the promise that coordinates are never sent survives someone re-enabling it.
   */
  it('refuses IP-derived geolocation on every event', () => {
    expect(send({})?.$geoip_disable).toBe(true);
    expect(send({ $current_url: 'https://gli.app/feed' })?.$geoip_disable).toBe(true);
  });

  it('stamps autocapture and pageviews too, not only the hand-written events', () => {
    // `before_send` runs on everything the SDK sends, which is why the stamp lives there rather
    // than in `useAnalytics` — a `$pageview` never passes through the typed capture wrapper.
    expect(send({ $current_url: 'https://gli.app/feed' })?.environment).toBe(env.deployEnvironment);
  });
});
