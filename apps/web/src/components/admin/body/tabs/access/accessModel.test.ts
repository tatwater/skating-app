import { describe, expect, it } from 'vitest';

import { BOARD_TODAY, MASCOMA_ACCESS } from './accessFixtures';
import {
  accessFrom,
  accessMapDrawing,
  dayCount,
  daysSince,
  rulingOf,
  rulingStatement,
  verdictWords,
  whereOf,
} from './accessModel';

const RULED = new Date(2026, 8, 21, 12).getTime();
const open = { verdict: 'open' as const, decidedAt: RULED, decidedByUserId: 'p1' };
const row = (createdAt: number, prev: unknown) => ({
  createdAt,
  actor: { displayName: 'Teagan', username: 'teagan' },
  metadata: { publicAccess: open, prev: { publicAccess: prev } },
});

describe('the ruling', () => {
  it('says an accessible ruling as the app does, as a status with no period', () => {
    expect(rulingStatement(open)).toBe('Accessible to the public');
    expect(rulingStatement({ ...open, verdict: 'none' })).toMatch(/no public access .*\.$/);
    expect(rulingStatement(undefined)).toBeNull();
  });

  it('takes who ruled and what stood before from the row that made the ruling', () => {
    expect(rulingOf(open, row(RULED + 400, null))).toEqual({
      verdict: 'open',
      statement: 'Accessible to the public',
      decidedAt: RULED,
      decidedBy: { name: 'Teagan', handle: 'teagan' },
      before: null,
    });
    expect(rulingOf(open, row(RULED, { verdict: 'none' })).before).toBe('none');
  });

  it('knows neither when the newest row is another ruling’s, or there is none', () => {
    const stale = rulingOf(open, row(RULED - 86_400_000, null));
    expect([stale.decidedBy, stale.before]).toEqual([null, undefined]);
    expect(rulingOf(open, null).before).toBeUndefined();
    expect(rulingOf(open, undefined).decidedBy).toBeNull();
  });

  it('reads a cleared ruling’s row for what stood before, with no one to name', () => {
    const cleared = rulingOf(undefined, row(RULED, open));
    expect(cleared).toMatchObject({ verdict: null, decidedBy: null, before: 'open' });
  });

  it('names each state, and counts whole days in the viewer’s zone', () => {
    expect([verdictWords('open'), verdictWords('none'), verdictWords(null)]).toEqual([
      'Ruled accessible',
      'Ruled no public access',
      'No ruling',
    ]);
    expect(daysSince(RULED, BOARD_TODAY)).toBe(23);
    expect(daysSince(BOARD_TODAY, RULED)).toBe(0);
    expect([dayCount(1), dayCount(23)]).toEqual(['1 day', '23 days']);
  });
});

describe('accessFrom', () => {
  const landmarks = [
    { name: 'Mascoma Lake Dam', point: { lat: 43.6497, lng: -72.1798 } },
    { name: 'Far Away', point: { lat: 44, lng: -72 } },
  ];

  it('orders official, mapped, then reported put-ins; a walk only with a lot', () => {
    const data = accessFrom(
      {
        putIns: [
          { id: 'd', coord: { lat: 1, lng: 1 }, name: 'Cluster', source: 'derived' },
          {
            id: 'o',
            coord: { lat: 43.6489, lng: -72.1793 },
            name: 'NW launch',
            source: 'osm',
            parkingAreaId: 'lot',
            approachMeters: 714.6,
            approachPath: [
              { lat: 1, lng: 1 },
              { lat: 2, lng: 2 },
            ],
          },
          {
            id: 'f',
            coord: { lat: 43.6489, lng: -72.1793 },
            source: 'official',
            approachMeters: 9,
          },
        ],
        parking: [{ id: 'lot', coord: { lat: 3, lng: 3 }, name: 'Dam lot' }],
        alerts: [
          { id: 'a', reason: 'gate_locked', parkingAreaId: 'lot', official: false },
          { id: 'b', reason: 'mystery', putInId: 'nope', official: true },
        ],
      },
      rulingOf(undefined, null),
      undefined,
      landmarks,
    );
    expect(data.putIns.map((p) => [p.id, p.source, p.walkM, p.where])).toEqual([
      ['f', 'official', null, null],
      ['o', 'osm', 715, 'Mascoma Lake Dam'],
      ['d', 'derived', null, null],
    ]);
    expect(data.putIns[0]?.name).toBe('Unnamed put-in');
    expect(data.putIns[1]?.approach).toHaveLength(2);
    expect(data.alerts).toEqual([
      { id: 'a', label: 'Gate locked', on: 'Dam lot', official: false },
      { id: 'b', label: 'mystery', on: null, official: true },
    ]);
    expect(data.postedRule).toBeNull();
    expect(data.lots).toEqual([{ id: 'lot', name: 'Dam lot', at: { lat: 3, lng: 3 } }]);
  });

  it('says the posted rule in words, and nothing for a rule with nothing to say', () => {
    const empty = { putIns: [], parking: [], alerts: [] };
    const none = rulingOf(undefined, null);
    expect(
      accessFrom(empty, none, { dailyWindow: { kind: 'daylight', offsetMinutes: 0 } }, null)
        .postedRule,
    ).toMatch(/sunrise/i);
    expect(accessFrom(empty, none, { note: 'A sign' }, null).postedRule).toBeNull();
  });

  it('names where a launch is by the nearest landmark within reach, else nothing', () => {
    expect(whereOf({ lat: 43.6489, lng: -72.1793 }, landmarks)).toBe('Mascoma Lake Dam');
    expect(whereOf({ lat: 43.5, lng: -72.5 }, landmarks)).toBeNull();
    expect(whereOf({ lat: 43.5, lng: -72.5 }, null)).toBeNull();
  });
});

describe('accessMapDrawing', () => {
  it('draws put-ins, lots and walks, the lit one marked', () => {
    const data = {
      ...MASCOMA_ACCESS,
      putIns: MASCOMA_ACCESS.putIns.map((p, i) =>
        i === 3
          ? {
              ...p,
              approach: [
                { lat: 1, lng: 1 },
                { lat: 2, lng: 2 },
              ],
            }
          : p,
      ),
    };
    const d = accessMapDrawing(data, 'put-in:pi-dam');
    expect(d.points.filter((p) => p.mark === 'put-in')).toHaveLength(6);
    expect(d.points.filter((p) => p.mark === 'lot')).toHaveLength(5);
    expect(d.lines).toEqual([
      { id: 'approach:pi-dam', style: 'approach', path: data.putIns[3]?.approach, lit: true },
    ]);
    expect(d.lit).toBe('put-in:pi-dam');
    expect(accessMapDrawing(data, 'ruling').lit).toBeNull();
    expect(accessMapDrawing(data, 'lot:lot-smith').points.find((p) => p.lit)?.label).toMatch(
      /^Smith Pond/,
    );
  });
});
