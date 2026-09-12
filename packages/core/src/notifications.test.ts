import { describe, expect, it } from 'vitest';
import { hazardLifecyclePhase } from './hazardLifecycle';
import {
  describeActors,
  describeNotification,
  NOTIFICATION_PREF_DEFAULTS,
  NOTIFICATION_PREF_KEY_FOR,
  NOTIFICATION_PREF_KEYS,
  NOTIFICATION_PREF_LABELS,
  NOTIFICATION_PREF_ORDER,
  NOTIFICATION_TYPES,
  type NotificationView,
} from './notifications';

const base = { id: 'n1', createdAt: 1_700_000_000_000 };
const lake = { id: 'b1', name: 'Lake Morey' };
const ok = { id: 'r1', available: true };
const gone = { id: 'r1', available: false };

describe('the notification vocabulary (D16 / D168)', () => {
  it('mirrors types and pref keys 1:1, and every key has a default, a label and a place in the order', () => {
    expect(NOTIFICATION_PREF_KEYS).toHaveLength(NOTIFICATION_TYPES.length);
    for (const type of NOTIFICATION_TYPES) {
      const key = NOTIFICATION_PREF_KEY_FOR[type];
      expect(NOTIFICATION_PREF_KEYS).toContain(key);
      expect(typeof NOTIFICATION_PREF_DEFAULTS[key]).toBe('boolean');
      expect(NOTIFICATION_PREF_LABELS[key].length).toBeGreaterThan(0);
    }
    expect([...NOTIFICATION_PREF_ORDER].sort()).toEqual([...NOTIFICATION_PREF_KEYS].sort());
  });
});

describe('describeActors', () => {
  it('reads naturally at one, two, three and many', () => {
    expect(describeActors({ names: [], count: 0 })).toBe('Someone');
    expect(describeActors({ names: ['Ellie'], count: 1 })).toBe('Ellie');
    expect(describeActors({ names: ['Ellie', 'Sam'], count: 2 })).toBe('Ellie and Sam');
    expect(describeActors({ names: ['Ellie', 'Sam'], count: 3 })).toBe('Ellie, Sam and 1 other');
    expect(describeActors({ names: ['Ellie', 'Sam'], count: 6 })).toBe('Ellie, Sam and 4 others');
    // A page that resolved only one name for a larger count still counts the rest.
    expect(describeActors({ names: ['Ellie'], count: 3 })).toBe('Ellie and 2 others');
  });
});

describe('describeNotification', () => {
  it('a thumb names the actors, the lake and the target kind, and taps through', () => {
    const view: NotificationView = {
      ...base,
      type: 'report_rated',
      kind: 'thumb',
      targetType: 'hazard',
      target: { id: 'h1', available: true },
      body: lake,
      actors: { names: ['Ellie'], count: 1 },
    };
    expect(describeNotification(view)).toEqual({
      title: 'Ellie found your hazard on Lake Morey helpful',
      target: { kind: 'hazard', id: 'h1' },
    });
  });

  it('a degraded target is described and not tappable (N8 #5)', () => {
    const view: NotificationView = {
      ...base,
      type: 'report_commented',
      reply: false,
      target: gone,
      body: null,
      actors: { names: ['Sam'], count: 1 },
      count: 1,
    };
    const d = describeNotification(view);
    expect(d.title).toBe('Sam commented on a report that’s no longer available');
    expect(d.target).toBeNull();
  });

  it('a reply reads as a reply and a burst carries its count', () => {
    const view: NotificationView = {
      ...base,
      type: 'report_commented',
      reply: true,
      target: ok,
      body: lake,
      actors: { names: ['Sam', 'Ada'], count: 3 },
      count: 4,
    };
    expect(describeNotification(view)).toEqual({
      title: 'Sam, Ada and 1 other replied to your comment on Lake Morey',
      detail: '4 new comments',
      target: { kind: 'report', id: 'r1' },
    });
  });

  it('hazard phases each have a sentence', () => {
    for (const phase of ['confirmed', 'healing_unsafe', 'disputed', 'archived'] as const) {
      const d = describeNotification({
        ...base,
        type: 'hazard_confirmation',
        target: { id: 'h1', available: true },
        body: lake,
        phase,
      });
      expect(d.title).toContain('Lake Morey');
      expect(d.target).toEqual({ kind: 'hazard', id: 'h1' });
    }
  });

  it('a flag verdict says only the verdict', () => {
    const d = describeNotification({
      ...base,
      type: 'content_flag_resolved',
      resolution: 'dismissed',
    });
    expect(d.title).toBe('A moderator reviewed something you flagged and left it up');
    expect(d.target).toBeNull();
  });

  it('report buckets land on the lake, the digest summarises across lakes', () => {
    expect(
      describeNotification({
        ...base,
        type: 'great_report_nearby',
        target: ok,
        body: lake,
        count: 2,
      }),
    ).toEqual({ title: '2 great reports on Lake Morey', target: { kind: 'water', id: 'b1' } });
    expect(
      describeNotification({
        ...base,
        type: 'nearby_report_digest',
        bodies: [
          { body: lake, target: ok, count: 2 },
          {
            body: { id: 'b2', name: 'Lake Fairlee' },
            target: { id: 'r2', available: true },
            count: 1,
          },
        ],
        totalCount: 3,
      }),
    ).toEqual({
      title: '3 new reports near you across 2 lakes',
      detail: 'Lake Morey · Lake Fairlee',
      target: { kind: 'water', id: 'b1' },
    });
  });

  it('the unknown row is a sentence too', () => {
    const d = describeNotification({ ...base, type: 'unknown' });
    expect(d.title.length).toBeGreaterThan(0);
    expect(d.target).toBeNull();
  });
});

describe('hazardLifecyclePhase', () => {
  it('orders archived > disputed > healing > confirmed > provisional', () => {
    expect(
      hazardLifecyclePhase({ status: 'archived', healingState: 'disputed', confirmCount: 5 }, true),
    ).toBe('archived');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'disputed', confirmCount: 5 }, true),
    ).toBe('disputed');
    expect(
      hazardLifecyclePhase(
        { status: 'active', healingState: 'healing_unsafe', confirmCount: 0 },
        false,
      ),
    ).toBe('healing_unsafe');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 1 }, false),
    ).toBe('confirmed');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 0 }, false),
    ).toBe('provisional');
    // A passage marker needs two confirmations (D64).
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 1 }, true),
    ).toBe('provisional');
    expect(
      hazardLifecyclePhase({ status: 'active', healingState: 'none', confirmCount: 2 }, true),
    ).toBe('confirmed');
  });
});
