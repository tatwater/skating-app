import { describe, expect, it } from 'vitest';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { BOARD_TODAY, MASCOMA_ACCESS } from './accessFixtures';
import {
  accessFrom,
  accessMapScene,
  dayCount,
  daysSince,
  earlierWords,
  rulingFrom,
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
      rulingFrom(undefined, 'wb1', 'hidden'),
      undefined,
      landmarks,
    );
    expect(data.putIns.map((p) => [p.id, p.source, p.walk, p.where])).toEqual([
      ['f', 'official', null, null],
      ['o', 'osm', { meters: 715, atLeast: false }, 'Mascoma Lake Dam'],
      ['d', 'derived', null, null],
    ]);
    expect(data.putIns[0]?.name).toBe('Unnamed put-in');
    // The placeholder is words to read, flagged so it is never stored as a name.
    expect(data.putIns[0]?.unnamed).toBe(true);
    expect(data.putIns[1]?.unnamed).toBeUndefined();
    expect(data.putIns[1]?.approach).toHaveLength(2);
    expect(data.alerts).toEqual([
      { id: 'a', label: 'Gate locked', on: 'Dam lot', official: false },
      { id: 'b', label: 'mystery', on: null, official: true },
    ]);
    expect(data.postedRule).toBeNull();
    expect(data.lots).toEqual([{ id: 'lot', name: 'Dam lot', at: { lat: 3, lng: 3 } }]);
  });

  it('keeps a straight-line walk a floor: a lot a moderator linked is at least that far', () => {
    const walkOf = (approachRouted: boolean | undefined) =>
      accessFrom(
        {
          putIns: [
            {
              id: 'o',
              coord: { lat: 43.6489, lng: -72.1793 },
              source: 'official',
              parkingAreaId: 'lot',
              approachMeters: 412.4,
              ...(approachRouted === undefined ? {} : { approachRouted }),
            },
          ],
          parking: [{ id: 'lot', coord: { lat: 3, lng: 3 } }],
          alerts: [],
        },
        rulingFrom(undefined, 'wb1', 'hidden'),
        undefined,
        [],
      ).putIns[0]?.walk;
    // `linkLot` stores the crow-flies leg with `approachRouted: false`; trails weave, so it's a floor.
    expect(walkOf(false)).toEqual({ meters: 412, atLeast: true });
    expect(walkOf(true)).toEqual({ meters: 412, atLeast: false });
    // A row from before the flag existed: the ETL only ever stored routed walks, as core reads it.
    expect(walkOf(undefined)).toEqual({ meters: 412, atLeast: false });
  });

  it('says the posted rule in words, and nothing for a rule with nothing to say', () => {
    const empty = { putIns: [], parking: [], alerts: [] };
    const none = rulingFrom(undefined, 'wb1', 'hidden');
    expect(
      accessFrom(empty, none, { dailyWindow: { kind: 'daylight', offsetMinutes: 0 } }, [])
        .postedRule,
    ).toMatch(/sunrise/i);
    expect(accessFrom(empty, none, { note: 'A sign' }, []).postedRule).toBeNull();
  });

  it('names where a launch is by the nearest landmark’s real name within reach, else nothing', () => {
    expect(whereOf({ lat: 43.6489, lng: -72.1793 }, landmarks)).toBe('Mascoma Lake Dam');
    expect(whereOf({ lat: 43.5, lng: -72.5 }, landmarks)).toBeNull();
    expect(whereOf({ lat: 43.5, lng: -72.5 }, [])).toBeNull();
    // The landmarks' read in its state: loading stays loading, a failure stays a failure.
    expect(whereOf({ lat: 43.5, lng: -72.5 }, undefined)).toBeUndefined();
    expect(whereOf({ lat: 43.5, lng: -72.5 }, FAILED_READ)).toBe(FAILED_READ);
  });

  it('names what failed: the landmarks, and the ruling’s history', () => {
    const one = {
      putIns: [{ id: 'o', coord: { lat: 1, lng: 1 }, source: 'osm' }],
      parking: [],
      alerts: [],
    };
    const data = accessFrom(one, rulingFrom(undefined, 'wb1', FAILED_READ), undefined, FAILED_READ);
    expect(data.putIns[0]?.where).toBe(FAILED_READ);
    expect(data.failures).toEqual(['who ruled', 'where each launch is']);
    expect(accessFrom(one, rulingFrom(undefined, 'wb1', 'hidden'), undefined, []).failures).toEqual(
      [],
    );
  });
});

describe('the ruling’s history', () => {
  const entry = (targetId: string, createdAt: number, prev: unknown = null) => ({
    targetType: 'waterbody',
    targetId,
    createdAt,
    actor: { displayName: 'Teagan', username: 'teagan' },
    metadata: { prev: { publicAccess: prev } },
  });

  it('takes who ruled from the body’s own newest row, and counts the rest as earlier', () => {
    const ruling = rulingFrom(open, 'wb1', {
      entries: [
        // A body merged into this one ruled later: not this body's ruling.
        entry('absorbed', RULED + 5_000_000),
        entry('wb1', RULED + 200, { verdict: 'none' }),
        entry('wb1', RULED - 86_400_000),
      ],
      capped: false,
    });
    expect(ruling).toMatchObject({
      decidedBy: { name: 'Teagan', handle: 'teagan' },
      before: 'none',
      history: { earlier: 1, capped: false },
    });
    expect(earlierWords(ruling.history)).toBe('1 earlier ruling');
  });

  it('counts every row as earlier when none made the ruling in force', () => {
    const ruling = rulingFrom(open, 'wb1', {
      entries: [entry('wb1', RULED - 86_400_000), entry('wb1', RULED - 2 * 86_400_000)],
      capped: false,
    });
    expect(ruling.before).toBeUndefined();
    expect(ruling.history).toEqual({ earlier: 2, capped: false });
    expect(earlierWords(ruling.history)).toBe('2 earlier rulings');
  });

  it('never presents a capped history as whole', () => {
    const capped = rulingFrom(open, 'wb1', {
      entries: [
        entry('wb1', RULED),
        ...Array.from({ length: 19 }, (_, i) => entry('wb1', RULED - i - 1)),
      ],
      capped: true,
    });
    expect(earlierWords(capped.history)).toBe('19+ earlier rulings');
    const cappedNone = rulingFrom(open, 'wb1', { entries: [entry('wb1', RULED)], capped: true });
    expect(earlierWords(cappedNone.history)).toBe(
      'Earlier rulings may exist past what this read shows',
    );
    // Whole and only the one ruling: nothing to say.
    expect(
      earlierWords(
        rulingFrom(open, 'wb1', { entries: [entry('wb1', RULED)], capped: false }).history,
      ),
    ).toBeNull();
  });

  it('keeps the read’s state when it is loading, failed or withheld', () => {
    for (const state of [undefined, FAILED_READ, 'hidden'] as const) {
      const ruling = rulingFrom(open, 'wb1', state);
      expect(ruling.history).toBe(state);
      expect(ruling.before).toBeUndefined();
      expect(earlierWords(ruling.history)).toBeNull();
    }
  });

  it('names a ruler with no real name on record by their handle', () => {
    const ruling = rulingFrom(open, 'wb1', {
      entries: [{ ...entry('wb1', RULED), actor: { displayName: ' ', username: 'teagan' } }],
      capped: false,
    });
    expect(ruling.decidedBy).toEqual({ name: 'teagan', handle: 'teagan' });
  });
});

describe('accessMapScene', () => {
  it('adds each routed walk, and keeps a lit put-in or lot the frame draws', () => {
    const data = {
      ...MASCOMA_ACCESS,
      putIns: MASCOMA_ACCESS.putIns.map((p, i) =>
        i === 3
          ? {
              ...p,
              approach: [
                { lat: 1, lng: 2 },
                { lat: 3, lng: 4 },
              ],
            }
          : p,
      ),
    };
    const scene = accessMapScene(data, 'putIn:pi-dam');
    expect(scene.items).toEqual([
      {
        kind: 'line',
        id: 'approach:pi-dam',
        layer: 'putIns',
        style: 'approach',
        path: [
          [2, 1],
          [4, 3],
        ],
      },
    ]);
    expect(scene.lit).toBe('putIn:pi-dam');
    expect(accessMapScene(data, 'lot:lot-smith').lit).toBe('lot:lot-smith');
    expect(accessMapScene(data, 'publicAccess:ruling').lit).toBeNull();
    expect(accessMapScene(MASCOMA_ACCESS, null)).toEqual({ items: [], lit: null });
  });
});
