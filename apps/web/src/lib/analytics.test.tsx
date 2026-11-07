import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_ENUMS,
  type AnalyticsEventName,
  bucketPointCount,
  bucketQueryLength,
  bucketUnreadCount,
  useAnalytics,
} from './analytics';

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

  /**
   * Every call site but one sits inside the `try` that reports a write back to the skater, so an
   * SDK that throws would turn a hazard that *did* file into "Could not save that hazard" — and
   * the honest response to that message is to file the pin again. A lost count is cheaper than a
   * duplicate hazard on the map, so the wrapper is where the throw stops.
   */
  it('swallows a throwing capture rather than failing the action it measures', () => {
    mocks.capture.mockImplementationOnce(() => {
      throw new Error('posthog exploded');
    });
    const { result } = renderHook(() => useAnalytics());

    expect(() => result.current.capture('report_updated')).not.toThrow();
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
  /**
   * `Record<AnalyticsEventName, true>` rather than an array: adding an event without adding it
   * here is now a compile error in both directions, so the list can't quietly fall behind the
   * interface.
   */
  const EXPECTED: Record<AnalyticsEventName, true> = {
    onboarding_completed: true,
    report_posted: true,
    report_updated: true,
    hazard_reported: true,
    existing_hazard_confirmed: true,
    bounty_posted: true,
    comment_created: true,
    water_body_favorited: true,
    water_body_unfavorited: true,
    water_body_request_submitted: true,
    // The B03 skater-web taxonomy (D240).
    water_body_opened: true,
    water_body_tab_viewed: true,
    report_viewed: true,
    hazard_viewed: true,
    bounty_viewed: true,
    search_opened: true,
    search_result_opened: true,
    search_no_results: true,
    latest_filter_changed: true,
    latest_report_opened: true,
    wanted_bounty_opened: true,
    report_sheet_opened: true,
    report_sheet_refused: true,
    report_sheet_abandoned: true,
    report_draft_restored: true,
    report_post_retried: true,
    report_photos_added: true,
    gpx_import_started: true,
    gpx_import_completed: true,
    hazard_flow_started: true,
    hazard_verdict_submitted: true,
    map_layer_toggled: true,
    imagery_opened: true,
    return_to_region_used: true,
    directions_opened: true,
    notifications_opened: true,
    notification_opened: true,
    theme_changed: true,
    strava_connect_started: true,
    sign_in_code_sent: true,
    sign_in_completed: true,
  };
  const names = Object.keys(EXPECTED);

  it('names every event in snake_case, which is what PostHog groups on', () => {
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  /**
   * D3: nothing here may read as a statement about the ice. These events record what a person did —
   * posted, confirmed, favorited — and a name built on a condition word would be a claim.
   */
  it('names no event after a condition of the ice (D3)', () => {
    for (const name of names) {
      expect(name).not.toMatch(/safe|unsafe|skateable|good|bad|thick|solid|clear/);
    }
  });

  /**
   * The same rule over every enum *value* an event can carry (D240). The hazard verdicts are the
   * author's own claims as labeled in the UI — 'fully_healed', 'still_there' — and deliberately
   * none of them matches a go/no-go word: the test is what keeps a future value honest.
   */
  it('carries no enum value that reads as an all-clear or a recommendation (D3)', () => {
    const CONDITION_CLAIM =
      /safe|skateable|good_to_go|all_clear|ok_to|go_no_go|conditions_(ok|good)|recommend(ed)?_ice/;
    for (const [key, values] of Object.entries(ANALYTICS_ENUMS)) {
      for (const value of values) {
        expect(`${key}:${value}`).not.toMatch(CONDITION_CLAIM);
      }
    }
  });
});

describe('the bucket helpers', () => {
  it('bucket boundaries land where the labels say', () => {
    expect(bucketQueryLength(1)).toBe('1-2');
    expect(bucketQueryLength(2)).toBe('1-2');
    expect(bucketQueryLength(3)).toBe('3-5');
    expect(bucketQueryLength(5)).toBe('3-5');
    expect(bucketQueryLength(6)).toBe('6-11');
    expect(bucketQueryLength(11)).toBe('6-11');
    expect(bucketQueryLength(12)).toBe('12+');

    expect(bucketPointCount(1)).toBe('1-99');
    expect(bucketPointCount(99)).toBe('1-99');
    expect(bucketPointCount(100)).toBe('100-999');
    expect(bucketPointCount(999)).toBe('100-999');
    expect(bucketPointCount(1000)).toBe('1000-9999');
    expect(bucketPointCount(9999)).toBe('1000-9999');
    expect(bucketPointCount(10000)).toBe('10000+');

    expect(bucketUnreadCount(0)).toBe('0');
    expect(bucketUnreadCount(-2)).toBe('0');
    expect(bucketUnreadCount(1)).toBe('1-3');
    expect(bucketUnreadCount(3)).toBe('1-3');
    expect(bucketUnreadCount(4)).toBe('4-9');
    expect(bucketUnreadCount(9)).toBe('4-9');
    expect(bucketUnreadCount(10)).toBe('10+');
  });

  it('every bucket label is a value of its enum', () => {
    expect(ANALYTICS_ENUMS.query_length_bucket).toContain(bucketQueryLength(4));
    // A Recent pick's own value: no query, so no length (D240), and no claim about the ice (D3).
    expect(ANALYTICS_ENUMS.query_length_bucket).toContain('recent');
    expect(ANALYTICS_ENUMS.point_count_bucket).toContain(bucketPointCount(500));
    expect(ANALYTICS_ENUMS.unread_bucket).toContain(bucketUnreadCount(2));
  });
});
