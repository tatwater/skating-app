import type { NotificationView } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  applyReadOverlay,
  cachedNotificationsFromRows,
  fromCachedRow,
  toCachedRow,
  unreadAfterOverlay,
} from './notificationCacheModel';

const view = (id: string, createdAt: number, readAt?: number): NotificationView => ({
  id,
  createdAt,
  ...(readAt !== undefined ? { readAt } : {}),
  type: 'content_flag_resolved',
  resolution: 'actioned',
});

describe('notificationCacheModel (N8 PR 3)', () => {
  it('round-trips a view and drops a corrupt row', () => {
    const v = view('n1', 100);
    expect(fromCachedRow(toCachedRow(v))).toEqual(v);
    expect(fromCachedRow({ data: 'not json' })).toBeNull();
    expect(fromCachedRow({ data: '{"id":1}' })).toBeNull();
    // A type this build has retired renders degraded rather than reaching `describeNotification`.
    expect(
      fromCachedRow({
        data: JSON.stringify({ id: 'old', createdAt: 7, readAt: 9, type: 'bounty_fulfilled' }),
      }),
    ).toEqual({ id: 'old', createdAt: 7, readAt: 9, type: 'unknown' });
    expect(
      cachedNotificationsFromRows([
        toCachedRow(view('a', 1)),
        { id: 'x', createdAt: 5, data: '[' },
        toCachedRow(view('b', 3)),
      ]).map((n) => n.id),
    ).toEqual(['b', 'a']);
  });

  it('the overlay fills read gaps but never overrides a server stamp', () => {
    const live = [view('a', 1), view('b', 2, 50), view('c', 3)];
    const overlay = new Map([
      ['a', 10],
      ['b', 99],
    ]);
    expect(applyReadOverlay(live, overlay).map((v) => v.readAt)).toEqual([10, 50, undefined]);
    expect(unreadAfterOverlay(live, overlay)).toBe(1);
  });
});
