import { describe, expect, it } from 'vitest';
import { env } from './env';
import { posthogOptions, stripUrlQuery } from './posthogOptions';

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

  /** D29 keeps both error paths; PostHog's is for funnel context, Sentry's is what pages us. */
  it('captures uncaught exceptions alongside Sentry', () => {
    expect(posthogOptions.capture_exceptions).toBe(true);
  });

  /** `identified_only` person profiles ride on this; losing it would create a person per visitor. */
  it('opts into the dated defaults rather than drifting with the SDK', () => {
    expect(posthogOptions.defaults).toBe('2025-05-24');
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
      $referrer: 'https://gli.app/u/teagan',
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

  it("leaves the app's own event properties alone", () => {
    expect(send({ hazard_type: 'pressure_ridge', photo_count: 2 })).toEqual({
      hazard_type: 'pressure_ridge',
      photo_count: 2,
    });
  });

  it('passes a dropped event and a property-less event through without throwing', () => {
    expect(posthogOptions.before_send(null)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: a CaptureResult stub, not a real capture
    expect(() => posthogOptions.before_send({} as any)).not.toThrow();
  });
});
