import { describe, expect, it } from 'vitest';

import {
  bayPickId,
  buildRecentGroup,
  buildResultGroups,
  cardBodyIds,
  hrefForPick,
  MAX_SEARCH_ROWS,
  parseBayPickId,
  pickKey,
  type RecentCard,
  type ResolvedPick,
  rankOf,
  recentBodyIds,
  recentReportsLabel,
  rowFromSkater,
  rowFromWaterHit,
  splitMatch,
  type WaterHit,
  waterSubLine,
} from './searchModel';

const NOW = new Date('2027-01-16T17:00:00Z').getTime(); // Saturday, noon in New York
const ZONE = 'America/New_York';
const HOUR = 3_600_000;

const lake = (id: string, name = 'Mascoma Lake'): WaterHit => ({
  kind: 'body',
  _id: id,
  waterBodyId: id,
  name,
  type: 'reservoir',
  states: ['NH'],
});
const bay = (id: string, parent: string, name = 'Mascoma North'): WaterHit => ({
  kind: 'subArea',
  _id: id,
  waterBodyId: parent,
  name,
  parentName: 'Mascoma Lake',
  type: 'reservoir',
  states: ['NH'],
});
const skater = (n: number) => ({
  userId: `u${n}`,
  username: `skater${n}`,
  displayName: `Skater ${n}`,
});

describe('labels', () => {
  it('writes the kind and the states, and badges a dormant body', () => {
    expect(waterSubLine('reservoir', ['NH'])).toBe('Reservoir · NH');
    expect(waterSubLine('lakePond', [])).toBe('Lake or pond');
    expect(waterSubLine('lakePond', ['VT', 'NH'], true)).toMatch(
      /^Inactive · Lake or pond · VT, NH$/,
    );
  });

  it('counts today’s reports, or the latest day’s by weekday, and says nothing for none', () => {
    expect(recentReportsLabel([], NOW, ZONE)).toBeUndefined();
    const today = [
      { skateEndTime: NOW - HOUR },
      { skateEndTime: NOW - 2 * HOUR },
      { skateEndTime: NOW - 3 * HOUR },
    ];
    expect(recentReportsLabel(today, NOW, ZONE)).toBe('3 reports today');
    const tuesday = new Date('2027-01-12T15:00:00Z').getTime();
    expect(recentReportsLabel([{ skateEndTime: tuesday }], NOW, ZONE)).toBe('1 report Tue');
    // Without a zone, the runtime's.
    expect(recentReportsLabel([{ skateEndTime: NOW }], NOW)).toBe('1 report today');
  });
});

describe('picks', () => {
  it('round-trips a bay’s pair id and refuses a malformed one', () => {
    expect(parseBayPickId(bayPickId('w1', 's1'))).toEqual({ waterBodyId: 'w1', subAreaId: 's1' });
    expect(parseBayPickId('w1')).toBeNull();
    expect(parseBayPickId('a/b/c')).toBeNull();
  });

  it('sends each kind to its page, a bay framed on its lake', () => {
    expect(hrefForPick({ kind: 'water_body', id: 'w1' })).toBe('/water/w1');
    expect(hrefForPick({ kind: 'sub_area', id: 'w1/s1' })).toBe('/water/w1?sub=s1');
    expect(hrefForPick({ kind: 'sub_area', id: 'broken' })).toBeNull();
    expect(hrefForPick({ kind: 'skater', id: 'kd onovan' })).toBe('/u/kd%20onovan');
  });
});

describe('rows', () => {
  const cards: RecentCard[] = [
    {
      waterBodyId: 'w1',
      skateEndTime: NOW - HOUR,
      subAreaName: 'Mascoma North',
      silhouette: {
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        origin: { lat: 0.5, lng: 0.5 },
        path: [[0, 0]],
      },
    },
    {
      waterBodyId: 'w1',
      skateEndTime: NOW - 2 * HOUR,
      subAreaNames: ['Mascoma South', 'Mascoma North'],
    },
    { waterBodyId: 'w2', skateEndTime: NOW - HOUR },
  ];

  it('builds a lake row with its report line and only the outline of its silhouette', () => {
    const row = rowFromWaterHit(lake('w1'), cards, NOW, ZONE);
    expect(row).toMatchObject({
      kind: 'water_body',
      sub: 'Reservoir · NH',
      meta: '2 reports today',
      href: '/water/w1',
    });
    expect(row.silhouette).toEqual({
      rings: cards[0]?.silhouette?.rings,
      bbox: cards[0]?.silhouette?.bbox,
    });
    expect(row.silhouette).not.toHaveProperty('path');
    const quiet = rowFromWaterHit(lake('w9', '  '), [], NOW, ZONE);
    expect(quiet.name).toBe('Unnamed water');
    expect(quiet).not.toHaveProperty('meta');
    expect(quiet).not.toHaveProperty('silhouette');
  });

  it('builds a bay row that names its lake and counts the reports stamped with it', () => {
    const row = rowFromWaterHit(bay('s1', 'w1'), cards, NOW, ZONE);
    expect(row).toMatchObject({
      kind: 'sub_area',
      sub: 'In Mascoma Lake',
      meta: '2 reports today',
      href: '/water/w1?sub=s1',
      pick: { kind: 'sub_area', id: 'w1/s1' },
    });
    const orphan = rowFromWaterHit(
      { ...bay('s2', 'w3', 'Inland Sea'), parentName: undefined } as WaterHit,
      [],
      NOW,
    );
    expect(orphan.sub).toBe('A bay');
    expect(orphan).not.toHaveProperty('meta');
  });

  it('builds a skater row with the handle and the photo when there is one', () => {
    expect(rowFromSkater(skater(1))).toMatchObject({
      kind: 'skater',
      sub: '@skater1',
      href: '/u/skater1',
    });
    expect(rowFromSkater({ ...skater(2), profileImageUrl: 'https://x/y.png' }).imageUrl).toBe(
      'https://x/y.png',
    );
  });
});

describe('buildResultGroups', () => {
  it('groups lakes, bays and skaters in that order and drops the empty ones', () => {
    const groups = buildResultGroups([lake('w1'), bay('s1', 'w1')], [skater(1)], [], NOW);
    expect(groups.map((g) => g.label)).toEqual(['Lakes', 'Bays', 'Skaters']);
    expect(buildResultGroups([lake('w1')], [], [], NOW).map((g) => g.id)).toEqual(['lakes']);
    expect(buildResultGroups([], [], [], NOW)).toEqual([]);
  });

  it('caps the plate at six rows and keeps two for skaters', () => {
    const water = Array.from({ length: 10 }, (_, i) => lake(`w${i}`));
    const people = Array.from({ length: 5 }, (_, i) => skater(i));
    const groups = buildResultGroups(water, people, [], NOW);
    const flat = groups.flatMap((g) => g.items);
    expect(flat).toHaveLength(MAX_SEARCH_ROWS);
    expect(flat.filter((r) => r.kind === 'skater')).toHaveLength(2);
    // With little water, skaters take the room.
    const few = buildResultGroups([lake('w1')], people, [], NOW).flatMap((g) => g.items);
    expect(few.filter((r) => r.kind === 'skater')).toHaveLength(5);
  });

  it('ranks across groups from one', () => {
    const groups = buildResultGroups([lake('w1'), bay('s1', 'w1')], [skater(1)], [], NOW);
    expect(rankOf(groups, 'water_body:w1')).toBe(1);
    expect(rankOf(groups, 'skater:u1')).toBe(3);
  });

  it('asks for a bounded, stable list of lakes', () => {
    const ids = cardBodyIds([
      lake('b'),
      bay('s', 'a'),
      lake('a'),
      ...Array.from({ length: 9 }, (_, i) => lake(`z${i}`)),
    ]);
    expect(ids.length).toBeLessThanOrEqual(MAX_SEARCH_ROWS);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildRecentGroup', () => {
  const picks = [
    { kind: 'water_body', id: 'w1' },
    { kind: 'sub_area', id: 'w1/s1' },
    { kind: 'skater', id: 'pl' },
    { kind: 'water_body', id: 'gone' },
    { kind: 'sub_area', id: 'malformed' },
  ] as const;
  const resolved = new Map<string, ResolvedPick>([
    [
      pickKey(picks[0]),
      { kind: 'water_body', name: 'Mascoma Lake', type: 'reservoir', states: ['NH'] },
    ],
    [pickKey(picks[1]), { kind: 'sub_area', name: 'Mascoma North', parentName: 'Mascoma Lake' }],
    [
      pickKey(picks[2]),
      { kind: 'skater', displayName: 'Pat Lacasse', username: 'pl', imageUrl: 'https://x/p.png' },
    ],
    [pickKey(picks[4]), { kind: 'sub_area', name: 'x', parentName: 'y' }],
  ]);

  it('draws the resolved picks in order and leaves out the rest', () => {
    const cards: RecentCard[] = [
      { waterBodyId: 'w1', skateEndTime: NOW - HOUR, subAreaName: 'Mascoma North' },
    ];
    const [group] = buildRecentGroup(picks, resolved, cards, NOW, ZONE);
    expect(group?.label).toBe('Recent');
    expect(group?.items.map((r) => r.name)).toEqual([
      'Mascoma Lake',
      'Mascoma North',
      'Pat Lacasse',
    ]);
    expect(group?.items[0]?.meta).toBe('1 report today');
    expect(group?.items[1]).toMatchObject({ sub: 'In Mascoma Lake', meta: '1 report today' });
    expect(group?.items[2]).toMatchObject({ sub: '@pl', imageUrl: 'https://x/p.png' });
  });

  it('is no group at all with nothing to show', () => {
    expect(buildRecentGroup([], resolved, [], NOW)).toEqual([]);
    // A resolution of the wrong kind is ignored.
    const wrong = new Map<string, ResolvedPick>([
      ['water_body:w1', { kind: 'skater', displayName: 'x', username: 'x' }],
    ]);
    expect(buildRecentGroup([{ kind: 'water_body', id: 'w1' }], wrong, [], NOW)).toEqual([]);
  });

  it('lists the lakes the recents touch, bays through their lake', () => {
    expect(recentBodyIds(picks)).toEqual(['gone', 'w1']);
  });
});

describe('splitMatch', () => {
  it('splits around the first case-insensitive match', () => {
    expect(splitMatch('Mascoma Lake', 'ma')).toEqual({
      before: '',
      match: 'Ma',
      after: 'scoma Lake',
    });
    expect(splitMatch('Crystal Lake', 'LAKE')).toEqual({
      before: 'Crystal ',
      match: 'Lake',
      after: '',
    });
  });
  it('lights nothing for an empty query or a fuzzy hit', () => {
    expect(splitMatch('Mascoma Lake', '  ')).toBeNull();
    expect(splitMatch('Inland Sea', 'malletts')).toBeNull();
  });
});
