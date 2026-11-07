import { describe, expect, it, vi } from 'vitest';
import { posthogOptions } from './posthogOptions';

vi.mock('./env', () => ({
  env: {
    posthogKey: 'phc_test_token',
    posthogHost: '/rink',
    posthogUiHost: 'https://us.posthog.com',
  },
  isConfigured: { posthog: true },
}));

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

  /** Ingestion is same-origin so a blocker sees a first-party request (D235). */
  it('sends ingestion to the same-origin proxy path, not to a posthog.com host', () => {
    expect(posthogOptions.api_host).toBe('/rink');
    expect(posthogOptions.api_host.startsWith('/')).toBe(true);
  });

  /**
   * The proxy is why these two differ. Collapsing them would send the SDK's "open in PostHog"
   * links to the ingestion path, which serves no UI.
   */
  it('keeps the UI host separate from the ingestion host', () => {
    expect(posthogOptions.ui_host).toBe('https://us.posthog.com');
    expect(posthogOptions.ui_host).not.toBe(posthogOptions.api_host);
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
