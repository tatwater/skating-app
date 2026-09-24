import { describe, expect, it } from 'vitest';
import { buildBayRequests, DESTINATION_MIN_SKATED, parseBayPointsCsv } from './bayRequests';
import type { MentionRow } from './buildFromMentions';

const CSV = [
  'name,state,parent,messages,class,id,lat,lng,note',
  'Northwest Bay,VT,Lake Champlain,26,b,node/1,44.185053,-73.417627,"near declared parent; source spelling: ""North West Bay"""',
  'NW Bay,VT,Lake Champlain,4,b,node/1,44.185053,-73.417627,near declared parent',
  'Holcomb Bay,VT,,3,b,node/2,44.853603,-73.330741,no parent captured in corpus — nearest known parent lake: Lake St. Champlain; matched by proximity',
  'Missisquoi Bay,VT,Lake Champlain,7,b,node/3,45.0,-73.1,near declared parent',
  'Lost Bay,VT,Lake Nowhere,3,b,node/4,44.0,-73.0,no parent captured in corpus',
  'Carrie Bay,VT,Lake Champlain,4,c,,,,no OSM/GNIS bay feature found',
  'Broken Bay,VT,Lake Champlain,9,b,node/5,,,bad row',
].join('\n');

function mention(canonicalName: string, messages: number, skatedMessages: number): MentionRow {
  return {
    canonicalName,
    kind: 'bay',
    messages,
    mentions: messages,
    skatedMessages,
    states: 'VT:1',
    towns: '',
    parentBody: '',
  };
}

const MENTIONS = [
  mention('Northwest Bay', 26, 13),
  mention('NW Bay', 4, 2),
  mention('Holcomb Bay', 3, 3),
  mention('Missisquoi Bay', 7, 1),
  mention('Lost Bay', 3, 2),
  mention('Broken Bay', 9, 9),
];

describe('parseBayPointsCsv', () => {
  it('decodes the classification with its quoted notes, and refuses a file missing a column', () => {
    const rows = parseBayPointsCsv(CSV);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({
      name: 'Northwest Bay',
      cls: 'b',
      id: 'node/1',
      lat: 44.185053,
    });
    expect(rows[0]?.note).toContain('source spelling: "North West Bay"');
    expect(rows[5]?.cls).toBe('c');
    expect(() => parseBayPointsCsv('name,state\nx,VT')).toThrow(/missing expected column/);
  });
});

describe('buildBayRequests', () => {
  const build = () => buildBayRequests(MENTIONS, parseBayPointsCsv(CSV), 'test-campaign');

  it('one request per point feature, skated in two or more messages, most-mentioned first', () => {
    const { rows, stats } = build();
    expect(rows.map((r) => r.name)).toEqual(['Northwest Bay', 'Holcomb Bay', 'Lost Bay']);
    expect(stats).toEqual({ pointBays: 4, destinations: 3, referencePoints: 1, parentless: 0 });
    expect(DESTINATION_MIN_SKATED).toBe(2);
  });

  it('folds spelling variants that resolved to one feature into aliases, and sums their counts', () => {
    const nw = build().rows[0];
    expect(nw).toMatchObject({
      name: 'Northwest Bay',
      aliases: ['NW Bay'],
      state: 'VT',
      parentName: 'Lake Champlain',
      coord: { lat: 44.185053, lng: -73.417627 },
    });
    // A derived insight, never a post's text: the counts, the campaign, the feature id.
    expect(nw?.note).toBe('Corpus: 30 messages, 15 skated (test-campaign). node/1.');
  });

  it('a bay named as a reference point, not skated, is not a request (D202)', () => {
    expect(build().rows.some((r) => r.name === 'Missisquoi Bay')).toBe(false);
  });

  it('takes the nearest known parent from the note when the classification captured none', () => {
    const holcomb = build().rows.find((r) => r.name === 'Holcomb Bay');
    // Through the abbreviation's period; only the clause separator ends the name.
    expect(holcomb?.parentName).toBe('Lake St. Champlain');
    expect(holcomb?.aliases).toBeUndefined();
  });

  it('emits a row with no parent as empty, for a hand fill, rather than guessing', () => {
    const lost = build().rows.find((r) => r.name === 'Lost Bay');
    // The classification named a parent the note did not contradict — kept as given.
    expect(lost?.parentName).toBe('Lake Nowhere');
    const { rows, stats } = buildBayRequests(
      MENTIONS,
      parseBayPointsCsv(CSV).map((r) => (r.name === 'Lost Bay' ? { ...r, parent: '' } : r)),
      'c',
    );
    expect(rows.find((r) => r.name === 'Lost Bay')?.parentName).toBe('');
    expect(stats.parentless).toBe(1);
  });

  it('skips a point row without coordinates, and a mention row it cannot find keeps the file count', () => {
    const { rows } = build();
    expect(rows.some((r) => r.name === 'Broken Bay')).toBe(false);
    const without = buildBayRequests(
      MENTIONS.filter((m) => m.canonicalName !== 'Holcomb Bay'),
      parseBayPointsCsv(CSV),
      'c',
    );
    // No inventory row: the classification's own message count stands, but nothing skated.
    expect(without.rows.some((r) => r.name === 'Holcomb Bay')).toBe(false);
    expect(without.stats.referencePoints).toBe(2);
  });
});
