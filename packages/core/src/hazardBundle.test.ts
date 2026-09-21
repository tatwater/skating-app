import { describe, expect, it } from 'vitest';
import {
  BUNDLE_LOOKBACK_MS,
  bundledHazardIds,
  bundleWindow,
  hazardRefFor,
  isLocalHazardId,
  localHazardCandidateId,
  localHazardIdOf,
  optOutsFromSavedRefs,
  queuedBundleCandidates,
  toggleBundleOptOut,
} from './hazardBundle';
import { pointRadiusShape } from './hazardGeometry';
import { createQueuedHazard, type HazardQueueItem, type QueuedHazard } from './hazardQueue';

describe('bundledHazardIds', () => {
  it('includes every candidate by default (D55: pre-checked)', () => {
    expect(bundledHazardIds(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('drops the ones the author deselected', () => {
    expect(bundledHazardIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  // The candidate list is a live query. Storing the *selection* positively would mean a hazard that
  // finished syncing after the form opened arrives unchecked and is silently dropped from the
  // report — the exact thing storing opt-outs prevents.
  it('includes a candidate that appears after the author has already deselected another', () => {
    const optedOut = toggleBundleOptOut([], 'a', false);
    expect(bundledHazardIds(['a', 'b', 'late'], optedOut)).toEqual(['b', 'late']);
  });

  it('ignores an opt-out for a hazard that is no longer a candidate', () => {
    expect(bundledHazardIds(['a'], ['gone'])).toEqual(['a']);
  });

  it('preserves candidate order, so attachment matches what the prompt itemises', () => {
    expect(bundledHazardIds(['c', 'a', 'b'], [])).toEqual(['c', 'a', 'b']);
  });

  it('bundles nothing when there are no candidates', () => {
    expect(bundledHazardIds([], ['a'])).toEqual([]);
  });
});

describe('toggleBundleOptOut', () => {
  it('deselecting records an opt-out; re-selecting removes it', () => {
    const off = toggleBundleOptOut([], 'a', false);
    expect(off).toEqual(['a']);
    expect(toggleBundleOptOut(off, 'a', true)).toEqual([]);
  });

  it('is idempotent — a double-fire from a jittery tap adds the id once', () => {
    const once = toggleBundleOptOut([], 'a', false);
    expect(toggleBundleOptOut(once, 'a', false)).toEqual(['a']);
  });

  it('re-selecting something never deselected is a no-op', () => {
    expect(toggleBundleOptOut(['b'], 'a', true)).toEqual(['b']);
  });

  it('does not mutate the array it was given', () => {
    const before = ['a'];
    toggleBundleOptOut(before, 'b', false);
    expect(before).toEqual(['a']);
  });
});

describe('the local candidate id (D55 offline, A10 §9.1)', () => {
  it('round-trips a queue id through the prefix and reads a server id as itself', () => {
    expect(localHazardCandidateId('q1')).toBe('local:q1');
    expect(isLocalHazardId('local:q1')).toBe(true);
    expect(isLocalHazardId('srv1')).toBe(false);
    expect(localHazardIdOf('local:q1')).toBe('q1');
    expect(localHazardIdOf('srv1')).toBeNull();
    expect(hazardRefFor('local:q1')).toEqual({ localId: 'q1' });
    expect(hazardRefFor('srv1')).toEqual({ hazardId: 'srv1' });
  });
});

describe('bundleWindow', () => {
  it('is the skate when a start is known, else the lookback before its end', () => {
    expect(bundleWindow(1_000, 400)).toEqual({ from: 400, to: 1_000 });
    expect(bundleWindow(BUNDLE_LOOKBACK_MS + 5)).toEqual({ from: 5, to: BUNDLE_LOOKBACK_MS + 5 });
  });
});

describe('queuedBundleCandidates — the phone’s queue beside the server’s list', () => {
  const NOW = Date.UTC(2026, 0, 10, 12, 0);
  const SHAPE = pointRadiusShape({ lat: 44.4759, lng: -73.2121 }, 40);
  const queued = (overrides: Partial<QueuedHazard>): QueuedHazard => ({
    ...createQueuedHazard({
      id: 'q',
      idempotencyKey: 'k',
      now: NOW,
      type: 'open_water',
      shape: SHAPE,
      waterBodyId: 'body1',
    }),
    ...overrides,
  });

  it('offers this lake’s in-window rows — by local id while waiting, by server id once flushed — oldest first', () => {
    const items: HazardQueueItem[] = [
      queued({ id: 'later', capturedAt: NOW - 1_000 }),
      queued({ id: 'flushed', status: 'done', hazardId: 'srv-1', capturedAt: NOW - 3_000 }),
      queued({ id: 'otherLake', waterBodyId: 'body2' }),
      queued({ id: 'coordOnly', waterBodyId: undefined }),
      queued({ id: 'parked', status: 'error' }),
      queued({ id: 'lastWeek', capturedAt: NOW - 7 * 24 * 60 * 60 * 1000 }),
      queued({ id: 'afterSkate', capturedAt: NOW + 60_000 }),
      { kind: 'confirmation_vote', id: 'vote', status: 'pending' } as unknown as HazardQueueItem,
    ];
    expect(
      queuedBundleCandidates(items, {
        waterBodyId: 'body1',
        skateEndTime: NOW,
        serverIds: new Set(),
      }),
    ).toEqual([
      { id: 'srv-1', type: 'open_water', firstReportedAt: NOW - 3_000 },
      { id: 'local:later', type: 'open_water', firstReportedAt: NOW - 1_000 },
    ]);
  });

  it('a flushed row the server already lists is not offered twice; a start time narrows the window', () => {
    const items: HazardQueueItem[] = [
      queued({ id: 'flushed', status: 'done', hazardId: 'srv-1', capturedAt: NOW - 3_000 }),
      queued({ id: 'beforeStart', capturedAt: NOW - 10_000 }),
      queued({ id: 'during', capturedAt: NOW - 2_000 }),
    ];
    expect(
      queuedBundleCandidates(items, {
        waterBodyId: 'body1',
        skateEndTime: NOW,
        skateStartTime: NOW - 5_000,
        serverIds: new Set(['srv-1']),
      }).map((c) => c.id),
    ).toEqual(['local:during']);
  });

  it('offers nothing while the skate has no end time — a NaN window is not an open one', () => {
    const items: HazardQueueItem[] = [queued({ id: 'q1' })];
    expect(
      queuedBundleCandidates(items, {
        waterBodyId: 'body1',
        skateEndTime: Number.NaN,
        serverIds: new Set(),
      }),
    ).toEqual([]);
  });
});

describe('optOutsFromSavedRefs — a draft edit keeps the last choice (A10 §9.1)', () => {
  it('unchecks every candidate the saved refs do not name, by server id or local id', () => {
    expect(
      optOutsFromSavedRefs(
        ['srv-1', 'srv-2', 'local:h1', 'local:h2'],
        [{ hazardId: 'srv-1' }, { localId: 'h2' }],
      ),
    ).toEqual(['srv-2', 'local:h1']);
  });
  it('a fresh form keeps the default — nothing opted out', () => {
    expect(optOutsFromSavedRefs(['srv-1'], undefined)).toEqual([]);
  });
});
