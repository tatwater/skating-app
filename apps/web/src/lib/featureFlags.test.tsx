import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS, useFeatureFlag } from './featureFlags';

const mocks = vi.hoisted(() => ({
  configured: { posthog: true },
  isFeatureEnabled: vi.fn<(flag: string) => boolean | undefined>(),
  /** The listener PostHog would call when flags finish loading. */
  listeners: [] as (() => void)[],
  onFeatureFlags: vi.fn(),
}));

vi.mock('./env', () => ({
  env: { posthogKey: 'phc_test_token' },
  isConfigured: mocks.configured,
}));

vi.mock('@posthog/react', () => ({
  usePostHog: () => ({
    isFeatureEnabled: mocks.isFeatureEnabled,
    onFeatureFlags: mocks.onFeatureFlags,
  }),
}));

beforeEach(() => {
  mocks.configured.posthog = true;
  mocks.listeners = [];
  mocks.isFeatureEnabled.mockReset();
  mocks.onFeatureFlags.mockReset();
  mocks.onFeatureFlags.mockImplementation((listener: () => void) => {
    mocks.listeners.push(listener);
    return () => {
      mocks.listeners = mocks.listeners.filter((l) => l !== listener);
    };
  });
});

describe('useFeatureFlag', () => {
  it('returns the flag value once PostHog has one', () => {
    mocks.isFeatureEnabled.mockReturnValue(true);

    const { result } = renderHook(() => useFeatureFlag('gpx-import', false));

    expect(result.current).toBe(true);
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith('gpx-import');
  });

  /**
   * A flag PostHog has never heard of reads `undefined`, not `false`. Collapsing the two would make
   * a typo in a flag key indistinguishable from a flag that is genuinely off — and the fallback is
   * where the caller already wrote down which way a no-answer should go.
   */
  it('falls back when the flag is unknown to PostHog', () => {
    mocks.isFeatureEnabled.mockReturnValue(undefined);

    expect(renderHook(() => useFeatureFlag('latest-text-search', true)).result.current).toBe(true);
    expect(renderHook(() => useFeatureFlag('latest-text-search', false)).result.current).toBe(
      false,
    );
  });

  it('re-reads the flag when PostHog reports flags have loaded', () => {
    mocks.isFeatureEnabled.mockReturnValue(undefined);
    const { result } = renderHook(() => useFeatureFlag('latest-skater-filter', false));
    expect(result.current).toBe(false);

    mocks.isFeatureEnabled.mockReturnValue(true);
    act(() => {
      for (const listener of mocks.listeners) listener();
    });

    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount so a flag update cannot set state on a dead component', () => {
    mocks.isFeatureEnabled.mockReturnValue(false);
    const { unmount } = renderHook(() => useFeatureFlag('gpx-import', false));
    expect(mocks.listeners).toHaveLength(1);

    unmount();

    expect(mocks.listeners).toHaveLength(0);
  });

  /**
   * Unconfigured must not touch the SDK at all — same reasoning as `useAnalytics`: the fallback
   * singleton logs an error per subscription, so a keyless run would be noisy rather than quiet.
   */
  it('returns the fallback and never touches PostHog when unconfigured', () => {
    mocks.configured.posthog = false;

    const { result } = renderHook(() => useFeatureFlag('gpx-import', true));

    expect(result.current).toBe(true);
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
    expect(mocks.onFeatureFlags).not.toHaveBeenCalled();
  });

  /**
   * The fallback is the safe side of the switch, and a caller may recompute which side that is.
   * With no PostHog to ask, the initial `useState` value is the only thing that would ever have
   * been returned — so a changed fallback has to be picked up explicitly.
   */
  it('follows a changed fallback while unconfigured', () => {
    mocks.configured.posthog = false;
    const { result, rerender } = renderHook(
      ({ fallback }: { fallback: boolean }) => useFeatureFlag('gpx-import', fallback),
      { initialProps: { fallback: false } },
    );
    expect(result.current).toBe(false);

    rerender({ fallback: true });

    expect(result.current).toBe(true);
  });
});

describe('FEATURE_FLAGS', () => {
  /**
   * The registry asserts the *claim*, so adding or dropping a flag forces whoever does it to come
   * back here and say so (the harness shipped empty under D235; B03 registered the first three
   * under D240 — each guards a convenience behind new server scope, never the shell and never
   * anything a skater's safety rests on, per D3).
   */
  it('registers exactly the B03 keys', () => {
    expect(FEATURE_FLAGS).toEqual(['latest-text-search', 'latest-skater-filter', 'gpx-import']);
  });

  it('names flags in kebab-case, matching the PostHog dashboard keys', () => {
    for (const key of FEATURE_FLAGS) expect(key).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
