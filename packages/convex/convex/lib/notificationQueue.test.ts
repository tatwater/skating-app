import { describe, expect, test } from 'vitest';
import type { Id } from '../_generated/dataModel';
import {
  actorCoalesceKey,
  mergeTriggers,
  type NotificationTrigger,
  triggerCount,
} from './notificationQueue';
import { parsePayload } from './notificationResolve';

const p = (s: string) => s as Id<'profiles'>;
const r = (s: string) => s as Id<'reports'>;
const c = (s: string) => s as Id<'comments'>;

describe('mergeTriggers / triggerCount (D169 coalescing)', () => {
  test('id lists union without duplicates; scalar state is overwritten by the newer trigger', () => {
    const thumb: NotificationTrigger = {
      kind: 'thumb',
      targetType: 'report',
      targetId: 'r',
      actorIds: [p('a')],
    };
    const merged = mergeTriggers(thumb, { ...thumb, actorIds: [p('a'), p('b')] });
    expect(merged).toEqual({ ...thumb, actorIds: [p('a'), p('b')] });
    expect(triggerCount(merged)).toBe(2);

    const corr: NotificationTrigger = {
      kind: 'corroboration',
      reportId: r('r'),
      byReportIds: [r('x')],
    };
    expect(triggerCount(mergeTriggers(corr, { ...corr, byReportIds: [r('y')] }))).toBe(2);

    const comment: NotificationTrigger = {
      kind: 'comment',
      reportId: r('r'),
      commentIds: [c('1')],
      actorIds: [p('a')],
    };
    const reply: NotificationTrigger = {
      kind: 'reply',
      reportId: r('r'),
      commentIds: [c('2')],
      actorIds: [p('b')],
    };
    expect(mergeTriggers(comment, reply)).toEqual(reply); // different kinds never merge
    expect(triggerCount(mergeTriggers(comment, { ...comment, commentIds: [c('2')] }))).toBe(2);

    const answered: NotificationTrigger = {
      kind: 'bounty_answered',
      bountyId: 'b' as Id<'bounties'>,
      waterBodyId: 'w' as Id<'waterBodies'>,
      reportIds: [r('1')],
    };
    expect(triggerCount(mergeTriggers(answered, { ...answered, reportIds: [r('2')] }))).toBe(2);

    const phase: NotificationTrigger = {
      kind: 'hazard_lifecycle',
      hazardId: 'h' as Id<'hazards'>,
      phase: 'confirmed',
      actorIds: [p('v')],
    };
    expect(mergeTriggers(phase, { ...phase, phase: 'archived' })).toEqual({
      ...phase,
      phase: 'archived',
    });
    expect(triggerCount(phase)).toBe(1);
    const flag: NotificationTrigger = {
      kind: 'flag_resolved',
      flagId: 'f' as Id<'contentFlags'>,
      resolution: 'actioned',
    };
    expect(mergeTriggers(flag, { ...flag, resolution: 'dismissed' })).toEqual({
      ...flag,
      resolution: 'dismissed',
    });
    const activity: NotificationTrigger = {
      kind: 'activity',
      activityId: 'a' as Id<'gpsActivities'>,
    };
    expect(triggerCount(activity)).toBe(1);
    const request: NotificationTrigger = {
      kind: 'bounty_request',
      bountyId: 'b' as Id<'bounties'>,
      waterBodyId: 'w' as Id<'waterBodies'>,
      requesterId: p('q'),
    };
    expect(triggerCount(request)).toBe(1);
  });

  test('the coalesce key is (recipient, target, kind)', () => {
    expect(actorCoalesceKey(p('u'), 't', 'thumb')).toBe('u:t:thumb');
  });
});

describe('parsePayload (the typed boundary over notifications.payload)', () => {
  test('rejects shapes this code never wrote, per type', () => {
    expect(parsePayload('report_rated', null)).toBeNull();
    expect(
      parsePayload('report_rated', { kind: 'thumb', targetType: 'photo', targetId: 'x' }),
    ).toBeNull();
    expect(parsePayload('report_rated', { kind: 'corroboration' })).toBeNull();
    expect(
      parsePayload('report_rated', { targetType: 'report', targetId: 'x', raterId: 'y' }),
    ).toBeNull();
    expect(parsePayload('report_commented', {})).toBeNull();
    expect(parsePayload('hazard_confirmation', { hazardId: 'h', phase: 'gone' })).toBeNull();
    expect(parsePayload('content_flag_resolved', { resolution: 'maybe' })).toBeNull();
    expect(parsePayload('bounty_request', { bountyId: 'b' })).toBeNull();
    expect(parsePayload('bounty_answered', { waterBodyId: 'w' })).toBeNull();
    expect(parsePayload('favorite_report', { waterBodyId: 'w' })).toBeNull();
    expect(parsePayload('nearby_report_digest', { bodies: 'nope' })).toBeNull();
    expect(parsePayload('nearby_report_digest', { bodies: [{ waterBodyId: 'w' }] })).toBeNull();
    expect(parsePayload('activity_detected', { activityId: 'a' })).toBeNull();
  });

  test('accepts each written shape and defaults the count and the digest total', () => {
    expect(
      parsePayload('report_rated', {
        kind: 'thumb',
        targetType: 'hazard',
        targetId: 'h',
        actorIds: ['a'],
      }),
    ).toEqual({
      kind: 'thumb',
      targetType: 'hazard',
      targetId: 'h',
      actorIds: ['a'],
      count: 1,
    });
    expect(
      parsePayload('report_rated', { kind: 'corroboration', reportId: 'r', count: 3 }),
    ).toEqual({
      kind: 'corroboration',
      reportId: 'r',
      count: 3,
    });
    expect(parsePayload('report_commented', { reportId: 'r', reply: true })).toMatchObject({
      reply: true,
      actorIds: [],
    });
    expect(parsePayload('hazard_confirmation', { hazardId: 'h', phase: 'archived' })).toEqual({
      kind: 'hazard_lifecycle',
      hazardId: 'h',
      phase: 'archived',
    });
    expect(parsePayload('content_flag_resolved', { resolution: 'dismissed' })).toEqual({
      kind: 'flag_resolved',
      resolution: 'dismissed',
    });
    expect(parsePayload('bounty_request', { bountyId: 'b', waterBodyId: 'w' })).toEqual({
      kind: 'bounty_request',
      bountyId: 'b',
      waterBodyId: 'w',
    });
    expect(
      parsePayload('bounty_answered', { bountyId: 'b', waterBodyId: 'w', count: 2 }),
    ).toMatchObject({ count: 2 });
    expect(parsePayload('great_report_nearby', { waterBodyId: 'w', reportId: 'r' })).toEqual({
      kind: 'report_bucket',
      waterBodyId: 'w',
      reportId: 'r',
      count: 1,
    });
    expect(
      parsePayload('nearby_report_digest', {
        bodies: [
          { waterBodyId: 'w', reportId: 'r', count: 2 },
          { waterBodyId: 'x', reportId: 'y' },
          { bad: true },
        ],
      }),
    ).toEqual({
      kind: 'digest',
      bodies: [
        { waterBodyId: 'w', reportId: 'r', count: 2 },
        { waterBodyId: 'x', reportId: 'y', count: 1 },
      ],
      totalCount: 3,
    });
    expect(
      parsePayload('activity_detected', { activityId: 'a', startTime: 5, waterBodyId: 'w' }),
    ).toEqual({
      kind: 'activity',
      activityId: 'a',
      waterBodyId: 'w',
      startTime: 5,
    });
  });
});
