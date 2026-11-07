import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AnalyticsEventName, useAnalytics } from './analytics';

const mocks = vi.hoisted(() => {
  const capture = vi.fn();
  return {
    configured: { posthog: true },
    capture,
    /** One object for the whole run: the real `usePostHog` hands back a stable client, and the
     * memo in `useAnalytics` is keyed on it, so a mock that returned a fresh object per render
     * would be testing the mock rather than the hook. */
    client: { capture },
  };
});

vi.mock('./env', () => ({
  env: { posthogKey: 'phc_test_token', posthogHost: '/rink' },
  isConfigured: mocks.configured,
}));

vi.mock('@posthog/react', () => ({
  usePostHog: () => mocks.client,
}));

beforeEach(() => {
  mocks.capture.mockClear();
  mocks.configured.posthog = true;
});

describe('useAnalytics', () => {
  it('forwards an event and its properties to PostHog unchanged', () => {
    const { result } = renderHook(() => useAnalytics());

    result.current.capture('hazard_reported', {
      hazard_type: 'pressure_ridge',
      geometry_kind: 'line',
      photo_count: 2,
    });

    expect(mocks.capture).toHaveBeenCalledWith('hazard_reported', {
      hazard_type: 'pressure_ridge',
      geometry_kind: 'line',
      photo_count: 2,
    });
  });

  /** The events that are a count of one carry no properties, and must not invent an empty object. */
  it('sends a property-less event with no properties at all', () => {
    const { result } = renderHook(() => useAnalytics());

    result.current.capture('onboarding_completed');

    expect(mocks.capture).toHaveBeenCalledWith('onboarding_completed', undefined);
  });

  /**
   * The keyless case is the normal one in tests and in any deployment without a token. It has to be
   * silent: `usePostHog` outside a provider hands back the uninitialized `posthog-js` singleton,
   * which logs an SDK error per call rather than throwing — so without this guard a green test run
   * would print one error line per simulated interaction, and a keyless deployment would do the
   * same in a skater's console.
   */
  it('is a no-op when no PostHog token is configured', () => {
    mocks.configured.posthog = false;
    const { result } = renderHook(() => useAnalytics());

    result.current.capture('report_posted', { report_count: 1 });
    result.current.capture('onboarding_completed');

    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('keeps one stable capture function across re-renders', () => {
    const { result, rerender } = renderHook(() => useAnalytics());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});

/**
 * The event *contract*, asserted as data.
 *
 * A dashboard reads these names; the app writes them. Nothing in the type system connects the two,
 * so a rename that compiles cleanly still silently orphans every chart built on the old name. This
 * list is the place that notices — a failure here means a PostHog insight needs updating too, which
 * is exactly the review conversation a rename should trigger.
 */
describe('the event contract', () => {
  const EXPECTED: readonly AnalyticsEventName[] = [
    'onboarding_completed',
    'report_posted',
    'report_updated',
    'hazard_reported',
    'existing_hazard_confirmed',
    'bounty_posted',
    'comment_created',
    'water_body_favorited',
    'water_body_unfavorited',
    'water_body_request_submitted',
  ];

  it('names every event in snake_case, which is what PostHog groups on', () => {
    for (const name of EXPECTED) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  /**
   * D3: nothing here may read as a statement about the ice. These events record what a person did —
   * posted, confirmed, favorited — and a name built on a condition word would be a claim.
   */
  it('names no event after a condition of the ice (D3)', () => {
    for (const name of EXPECTED) {
      expect(name).not.toMatch(/safe|unsafe|skateable|good|bad|thick|solid|clear/);
    }
  });
});
