import { describeNotification, type NotificationView } from '@skating/core';
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

describe('notificationCacheModel (A08 PR 3)', () => {
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
    // A known type whose shape has drifted (no `actors` on a thumb) degrades too, rather than
    // throwing inside the list when the sentence is composed.
    expect(
      fromCachedRow({
        data: JSON.stringify({
          id: 'drift',
          createdAt: 8,
          type: 'report_rated',
          kind: 'thumb',
          targetType: 'report',
          target: { id: 'r', available: true },
          body: null,
        }),
      }),
    ).toEqual({ id: 'drift', createdAt: 8, type: 'unknown' });
    expect(
      cachedNotificationsFromRows([
        toCachedRow(view('a', 1)),
        { id: 'x', createdAt: 5, data: '[' },
        toCachedRow(view('b', 3)),
      ]).map((n) => n.id),
    ).toEqual(['b', 'a']);
  });

  it('stores and reads a moderator’s decision, and words one in a shape this core doesn’t know (D285)', () => {
    const decision: NotificationView = {
      id: 'md',
      createdAt: 200,
      type: 'moderator_decision',
      about: 'name_landmark',
      outcome: 'declined',
      body: { id: 'b1', name: 'Lake Morey' },
      note: 'Already on the map',
    };
    expect(fromCachedRow(toCachedRow(decision))).toEqual(decision);
    expect(
      fromCachedRow({
        data: JSON.stringify({
          id: 'retracted',
          createdAt: 201,
          type: 'moderator_decision',
          about: 'accessAlert',
          outcome: 'retracted',
          body: null,
          place: 'North Ramp',
        }),
      }),
    ).toMatchObject({ type: 'moderator_decision', place: 'North Ramp' });
    // An `about` this core has no words for (cached by a later build, say) still reads: core words it
    // as a plain decision rather than throwing, so the row is kept as it came.
    const later = {
      id: 'later',
      createdAt: 202,
      type: 'moderator_decision',
      about: 'photo',
      outcome: 'approved',
      body: null,
    };
    expect(fromCachedRow({ data: JSON.stringify(later) })).toEqual(later);
    // Even a row drifted past its fields (no `about`, no body) is worded, never a throw in the list.
    const drift = fromCachedRow({
      data: JSON.stringify({ id: 'drift', createdAt: 203, type: 'moderator_decision' }),
    });
    expect(describeNotification(drift as NotificationView)).toEqual({
      title: 'A moderator made a decision on something you sent',
      target: null,
    });
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
