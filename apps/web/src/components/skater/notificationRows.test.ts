import type { NotificationView } from '@skating/core';
import { describe, expect, it } from 'vitest';

import {
  notificationGroups,
  notificationMark,
  notificationRowHref,
  notificationRows,
  notificationWhen,
} from './notificationRows';

const NOW = new Date('2027-01-16T17:00:00Z').getTime();
const ZONE = 'America/New_York';
const MIN = 60_000;
const body = { id: 'w1', name: 'Mascoma Lake' };
const target = { id: 'r1', available: true };

const v = (view: object, extra: object = {}): NotificationView =>
  ({ id: 'n1', createdAt: NOW - 12 * MIN, ...view, ...extra }) as NotificationView;

describe('notificationWhen', () => {
  it('writes minutes, hours, the weekday, then the date', () => {
    expect(notificationWhen(NOW - 10_000, NOW, ZONE)).toBe('now');
    expect(notificationWhen(NOW + 10_000, NOW, ZONE)).toBe('now');
    expect(notificationWhen(NOW - 12 * MIN, NOW, ZONE)).toBe('12 m');
    expect(notificationWhen(NOW - 60 * MIN, NOW, ZONE)).toBe('1 h');
    expect(notificationWhen(new Date('2027-01-15T17:00:00Z').getTime() - MIN, NOW, ZONE)).toBe(
      'Fri',
    );
    expect(notificationWhen(new Date('2027-01-09T17:00:00Z').getTime(), NOW, ZONE)).toBe('9 Jan');
    expect(notificationWhen(NOW - 30 * 24 * 60 * MIN, NOW)).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    expect(notificationWhen(NOW - 3 * 24 * 60 * MIN, NOW)).toMatch(/^[A-Z][a-z]{2}$/);
  });
});

describe('notificationMark', () => {
  it('shows the person for what someone did, a glyph for what happened', () => {
    const actors = { names: ['Sarah Berman'], count: 1 };
    expect(
      notificationMark(
        v({ type: 'report_commented', reply: false, target, body, actors, count: 1 }),
      ),
    ).toEqual({ kind: 'person', name: 'Sarah Berman' });
    expect(
      notificationMark(
        v({
          type: 'report_commented',
          reply: false,
          target,
          body,
          actors: { names: [], count: 0 },
          count: 1,
        }),
      ),
    ).toEqual({ kind: 'person', name: 'Someone' });
    expect(
      notificationMark(
        v({ type: 'report_rated', kind: 'thumb', targetType: 'report', target, body, actors }),
      ),
    ).toEqual({ kind: 'person', name: 'Sarah Berman' });
    expect(
      notificationMark(
        v({
          type: 'report_rated',
          kind: 'thumb',
          targetType: 'report',
          target,
          body,
          actors: { names: [], count: 0 },
        }),
      ),
    ).toEqual({ kind: 'person', name: 'Someone' });
    expect(
      notificationMark(v({ type: 'report_rated', kind: 'corroboration', target, body, count: 2 })),
    ).toEqual({ kind: 'icon', icon: 'report' });
    expect(
      notificationMark(v({ type: 'hazard_confirmation', target, body, phase: 'confirmed' })),
    ).toEqual({ kind: 'icon', icon: 'hazard', tone: 'bad' });
    expect(
      notificationMark(v({ type: 'activity_detected', activityId: 'a', body, startTime: NOW })),
    ).toEqual({ kind: 'icon', icon: 'clock' });
    expect(notificationMark(v({ type: 'bounty_request', target, body }))).toEqual({
      kind: 'icon',
      icon: 'bounty',
    });
    expect(notificationMark(v({ type: 'bounty_answered', target, body, count: 1 }))).toEqual({
      kind: 'icon',
      icon: 'bounty',
    });
    expect(notificationMark(v({ type: 'content_flag_resolved', resolution: 'dismissed' }))).toEqual(
      { kind: 'icon', icon: 'flag' },
    );
    expect(notificationMark(v({ type: 'favorite_report', target, body, count: 1 }))).toEqual({
      kind: 'icon',
      icon: 'report',
    });
    expect(notificationMark(v({ type: 'great_report_nearby', target, body, count: 1 }))).toEqual({
      kind: 'icon',
      icon: 'report',
    });
    expect(
      notificationMark(v({ type: 'nearby_report_digest', bodies: [], totalCount: 0 })),
    ).toEqual({ kind: 'icon', icon: 'report' });
    expect(notificationMark(v({ type: 'unknown' }))).toEqual({ kind: 'icon', icon: 'bell' });
  });
});

describe('notificationRowHref', () => {
  it('routes a target, sends a recorded skate to a new report on its lake, and leaves the rest untappable', () => {
    expect(
      notificationRowHref(
        v({
          type: 'hazard_confirmation',
          target: { id: 'h 1', available: true },
          body,
          phase: 'confirmed',
        }),
      ),
    ).toBe('/hazard/h%201');
    expect(
      notificationRowHref(v({ type: 'activity_detected', activityId: 'a', body, startTime: NOW })),
    ).toBe('/water/w1?post=new&postBody=w1');
    expect(
      notificationRowHref(
        v({ type: 'activity_detected', activityId: 'a', body: null, startTime: NOW }),
      ),
    ).toBeNull();
    expect(
      notificationRowHref(v({ type: 'content_flag_resolved', resolution: 'actioned' })),
    ).toBeNull();
  });
});

describe('notificationRows and groups', () => {
  const views = [
    v({ type: 'hazard_confirmation', target, body, phase: 'confirmed' }, { id: 'a' }),
    v({ type: 'favorite_report', target, body, count: 1 }, { id: 'b', readAt: NOW - MIN }),
    v({ type: 'unknown' }, { id: 'c', readAt: NOW - MIN }),
  ];

  it('keeps a row this opening stamped read drawn as new', () => {
    const rows = notificationRows(views, new Set(['b']), NOW, ZONE);
    expect(rows.map((r) => r.unread)).toEqual([true, true, false]);
    expect(rows[0]).toMatchObject({
      title: expect.stringContaining('still there'),
      when: '12 m',
      kind: 'hazard_confirmation',
      href: '/hazard/r1',
    });
    expect(rows[2]?.kind).toBeNull();
    expect(notificationRows(views, new Set(), NOW)[1]?.unread).toBe(false);
  });

  it('puts New before Earlier and drops an empty group', () => {
    const rows = notificationRows(views, new Set(), NOW, ZONE);
    expect(notificationGroups(rows).map((g) => [g.label, g.rows.length])).toEqual([
      ['New', 1],
      ['Earlier', 2],
    ]);
    expect(notificationGroups(rows.filter((r) => !r.unread)).map((g) => g.id)).toEqual(['earlier']);
    const detail = notificationRows(
      [
        v({
          type: 'report_commented',
          reply: false,
          target,
          body,
          actors: { names: ['A'], count: 1 },
          count: 2,
        }),
      ],
      new Set(),
      NOW,
    );
    expect(detail[0]?.detail).toBe('2 new comments');
  });
});
