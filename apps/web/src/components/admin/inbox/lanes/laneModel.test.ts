import { describe, expect, it } from 'vitest';

import { LANES, MODERATOR_LANES, NOW, PENDING_LANES, ZERO_LANES } from '../list/inboxFixtures';
import {
  ageCountsFor,
  inboxRailCount,
  laneOfRow,
  lanesFor,
  localMidnight,
  sidebarGroups,
  statusFacts,
} from './laneModel';

describe('the lanes a viewer has', () => {
  it('lists All open first, then the lanes safety first; Support only with support’s read', () => {
    expect(lanesFor(true)).toEqual([
      'all',
      'safety',
      'accessReports',
      'requests',
      'placesAsked',
      'drawnBodies',
      'contentFlags',
      'support',
    ]);
    expect(lanesFor(false)).not.toContain('support');
  });
});

describe('the sidebar', () => {
  it('draws the boards’ counts: 19 open, Safety red, Decided and Today quiet', () => {
    const [lanes, record] = sidebarGroups(LANES, true);
    expect(lanes?.label).toBe('Lanes');
    expect(lanes?.lanes.map((l) => [l.label, l.count, l.countTone])).toEqual([
      ['All open', '19', undefined],
      ['Safety', '1', 'bad'],
      ['Access reports', '3', undefined],
      ['Requests', '6', undefined],
      ['Places asked', '4', undefined],
      ['Drawn bodies', '1', undefined],
      ['Content flags', '2', undefined],
      ['Support', '2', undefined],
    ]);
    expect(record?.label).toBe('Record');
    expect(record?.lanes).toEqual([
      { id: 'decided', label: 'Decided', count: '1,118' },
      { id: 'today', label: 'Today', dim: true, count: '3' },
    ]);
  });

  it('dims every empty lane and keeps Safety quiet at zero (2.9)', () => {
    const [lanes] = sidebarGroups(ZERO_LANES, true);
    for (const lane of lanes?.lanes ?? []) {
      expect(lane.count).toBe('0');
      expect(lane.dim).toBe(true);
      expect(lane.countTone).toBeUndefined();
    }
  });

  it('shows no number while the server prepares, or before the read answers', () => {
    for (const view of [PENDING_LANES, undefined]) {
      for (const group of sidebarGroups(view, true)) {
        for (const lane of group.lanes) expect(lane.count).toBeUndefined();
      }
    }
  });

  it('a lane the read leaves out reads as empty, never as missing', () => {
    const [lanes] = sidebarGroups(MODERATOR_LANES, true);
    expect(lanes?.lanes.find((l) => l.id === 'support')).toMatchObject({ count: '0', dim: true });
  });

  it('writes a capped Today as a floor', () => {
    const [, record] = sidebarGroups({ ...LANES, today: { count: 500, capped: true } }, false);
    expect(record?.lanes[1]?.count).toBe('500+');
  });

  it('opens Decided from Today', () => {
    expect(laneOfRow('today')).toBe('decided');
    expect(laneOfRow('safety')).toBe('safety');
  });
});

describe('the rail’s count', () => {
  it('is every open item, amber, when something waits', () => {
    expect(inboxRailCount(LANES)).toEqual({ count: '19', countTone: 'warn' });
  });

  it('is nothing at zero, while preparing, before an answer, or from a strange answer', () => {
    expect(inboxRailCount(ZERO_LANES)).toEqual({});
    expect(inboxRailCount(PENDING_LANES)).toEqual({});
    expect(inboxRailCount(undefined)).toEqual({});
    expect(inboxRailCount(null)).toEqual({});
    expect(inboxRailCount({ displayName: 'x' } as never)).toEqual({});
  });
});

describe('the status bar’s facts', () => {
  it('reads Safety’s open count and today’s decided', () => {
    expect(statusFacts(LANES)).toEqual({ safety: 1, today: '3' });
    expect(statusFacts(PENDING_LANES)).toBeNull();
    expect(statusFacts(MODERATOR_LANES)).toEqual({ safety: 1, today: '3' });
    expect(statusFacts({ ...LANES, lanes: [] })).toEqual({ safety: 0, today: '3' });
  });
});

describe('local midnight', () => {
  it('is the start of the day an instant falls on, in the console’s zone', () => {
    const m = localMidnight(NOW);
    expect(new Date(m).getHours()).toBe(0);
    expect(new Date(m).getDate()).toBe(new Date(NOW).getDate());
    expect(NOW - m).toBe(12 * 3_600_000);
  });
});

describe('the age filter’s counts', () => {
  it('reads a lane’s own counts per floor', () => {
    // The fixtures' Safety: one item, four days old.
    expect(ageCountsFor(LANES, 'safety')).toEqual({ 1: 1, 3: 1, 7: 0, 30: 0 });
  });

  it('sums the lanes for All open', () => {
    const all = ageCountsFor(LANES, 'all');
    expect(all?.[1]).toBe(LANES.lanes.reduce((n, l) => n + (l.olderThan[0]?.count.count ?? 0), 0));
  });

  it('draws a count the server stopped at its cap as a floor — for a lane, and in All open', () => {
    const capped = {
      ...LANES,
      lanes: LANES.lanes.map((l) =>
        l.lane === 'accessReports'
          ? {
              ...l,
              olderThan: l.olderThan.map((o) => ({
                ...o,
                count: { count: 200, capped: o.days === 1 },
              })),
            }
          : l,
      ),
    };
    expect(ageCountsFor(capped, 'accessReports')).toEqual({
      1: { count: 200, capped: true },
      3: 200,
      7: 200,
      30: 200,
    });
    // All open sums its lanes; a sum with a capped lane in it is a floor too.
    const all = ageCountsFor(capped, 'all') ?? {};
    const oneDay = all[1] as { count: number; capped: boolean };
    expect(oneDay.capped).toBe(true);
    expect(oneDay.count).toBeGreaterThanOrEqual(200);
    expect(all[3]).toBeGreaterThan(200);
  });

  it('draws none while preparing, before an answer, for Decided, or a lane the read left out', () => {
    expect(ageCountsFor(PENDING_LANES, 'safety')).toBeUndefined();
    expect(ageCountsFor(undefined, 'safety')).toBeUndefined();
    expect(ageCountsFor(LANES, 'decided')).toBeUndefined();
    expect(ageCountsFor(MODERATOR_LANES, 'support')).toBeUndefined();
  });
});
