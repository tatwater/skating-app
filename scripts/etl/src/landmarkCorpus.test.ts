import { describe, expect, it } from 'vitest';
import {
  aliasResembles,
  applyCorpus,
  type CorpusPlace,
  corpusNameRecords,
  parseCsv,
  parseMentions,
} from './landmarkCorpus';
import type { MatchBody, PlacedLandmark } from './landmarkMatch';

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, embedded commas and newlines, and CRLF', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n"multi\nline",x\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['multi\nline', 'x'],
    ]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
    expect(parseCsv('')).toEqual([]);
  });
});

const HEADER =
  'canonicalName,kind,messages,mentions,skatedMessages,states,towns,parentBody,firstSeen,lastSeen,aliases';

describe('parseMentions', () => {
  it('keeps the places that can be landmarks, with their states and aliases', () => {
    const csv = [
      HEADER,
      'Apple Island,other,24,30,11,VT:20;unknown:4,South Hero(3),Lake Champlain,a,b,"Apple Is; apple island"',
      'Kingsland Bay,bay,3,3,0,VT:3,,Lake Champlain,a,b,',
      'Half Moon Cove,cove,3,3,0,,,,a,b,',
      'Lake Champlain,lake,349,426,112,VT:405,,Lake Champlain,a,b,',
      'unknown,other,26,26,0,,,,a,b,',
      ',other,1,1,0,,,,a,b,',
    ].join('\n');
    const places = parseMentions(csv);
    expect(places.map((p) => p.name)).toEqual(['Apple Island', 'Kingsland Bay', 'Half Moon Cove']);
    expect(places[0]).toEqual({
      name: 'Apple Island',
      kind: 'other',
      messages: 24,
      skatedMessages: 11,
      states: ['VT'],
      parentBody: 'Lake Champlain',
      aliases: ['Apple Is', 'apple island'],
    });
    expect(places[2]).toMatchObject({ states: [], aliases: [] });
    expect(places[2]?.parentBody).toBeUndefined();
  });

  it('refuses a file missing a column it reads, and reads an empty one as nothing', () => {
    expect(() => parseMentions('canonicalName,kind\nx,other')).toThrow(/missing a column/);
    expect(parseMentions('')).toEqual([]);
  });

  it('reads a non-numeric count as zero', () => {
    const [place] = parseMentions(`${HEADER}\nGull Rock,other,x,1,y,,,,a,b,`);
    expect(place).toMatchObject({ messages: 0, skatedMessages: 0 });
  });
});

describe('aliasResembles', () => {
  it.each([
    ['Shelb Bay', 'Shelburne Bay'],
    ['Missiquoi bay', 'Missisquoi Bay'],
    ['Isle LaMotte', 'Isle La Motte'],
    ['Arnolds Bay', 'Arnold Bay'],
    ['Savage', 'Savage Island'],
  ])('"%s" spells "%s"', (alias, name) => expect(aliasResembles(alias, name)).toBe(true));

  it.each([
    ["Carleton's Prize", 'Carry Bay'],
    ['inner bay', 'Malletts Bay'],
    ['the bay', 'Wolfeboro Bay'],
    ['Shelburne Bay, Lake Champlain', 'Shelburne Bay'],
    ['Lake Champlain (Stevenson Bay)', 'Stevenson Bay'],
  ])('"%s" does not spell "%s"', (alias, name) => expect(aliasResembles(alias, name)).toBe(false));
});

const bodies = new Map<string, MatchBody>(
  [
    { id: 'champlain', name: 'Lake Champlain', states: ['VT', 'NY'] },
    { id: 'george', name: 'Lake George', states: ['NY'] },
    { id: 'sunapee', name: 'Lake Sunapee', states: ['NH'] },
    { id: 'unnamed' },
  ].map((b) => [
    b.id,
    {
      ...b,
      polygon: { type: 'Polygon', coordinates: [] },
      bbox: { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 },
      surfaceAreaSqM: 1,
    } as MatchBody,
  ]),
);

function landmark(
  waterBodyId: string,
  name: string,
  kind: PlacedLandmark['kind'] = 'island',
): PlacedLandmark {
  return {
    waterBodyId,
    name,
    kind,
    point: { lat: 44, lng: -73 },
    source: 'osm',
    externalIds: [`osm:node/${waterBodyId}/${name}`],
    aliases: [],
  };
}

function place(name: string, extra: Partial<CorpusPlace> = {}): CorpusPlace {
  return { name, kind: 'other', messages: 5, skatedMessages: 1, states: [], aliases: [], ...extra };
}

describe('applyCorpus', () => {
  it('attaches a count and the spellings that resemble the name', () => {
    const savage = landmark('champlain', 'Savage Island');
    const byBody = new Map([['champlain', [savage]]]);
    const outcome = applyCorpus(byBody, bodies, [
      place('Savage Island', {
        messages: 8,
        aliases: ['Savage', 'Savage Is', "Carleton's Prize", 'savage island'],
      }),
    ]);
    expect(outcome.matched).toBe(1);
    expect(savage.corpusMessages).toBe(8);
    expect(savage.aliases).toEqual(['Savage', 'Savage Is']);
  });

  it('matches through a spacing difference', () => {
    const isle = landmark('champlain', 'Isle La Motte');
    applyCorpus(new Map([['champlain', [isle]]]), bodies, [place('Isle LaMotte', { messages: 4 })]);
    expect(isle.corpusMessages).toBe(4);
  });

  it('never lends a named parent’s count to another lake', () => {
    const george = landmark('george', 'Northwest Bay', 'bay');
    const outcome = applyCorpus(new Map([['george', [george]]]), bodies, [
      place('Northwest Bay', { kind: 'bay', parentBody: 'Lake Champlain', states: ['VT', 'NY'] }),
    ]);
    expect(outcome.unmatched.map((p) => p.name)).toEqual(['Northwest Bay']);
    expect(george.corpusMessages).toBeUndefined();
  });

  it('ignores a parent the catalog holds no body for, and narrows by state instead', () => {
    const nh = landmark('sunapee', 'Great Island');
    const ny = landmark('george', 'Great Island');
    const byBody = new Map([
      ['sunapee', [nh]],
      ['george', [ny]],
    ]);
    applyCorpus(byBody, bodies, [
      place('Great Island', { parentBody: 'Sugar River', states: ['NH'] }),
    ]);
    expect(nh.corpusMessages).toBe(5);
    expect(ny.corpusMessages).toBeUndefined();
  });

  it('calls two lakes, or two places on one lake, ambiguous', () => {
    const a = landmark('champlain', 'Cedar Island');
    const b = { ...landmark('champlain', 'Cedar Island'), externalIds: ['osm:node/2'] };
    const c = landmark('george', 'Long Point', 'point');
    const d = landmark('sunapee', 'Long Point', 'point');
    const byBody = new Map([
      ['champlain', [a, b]],
      ['george', [c]],
      ['sunapee', [d]],
    ]);
    const outcome = applyCorpus(byBody, bodies, [place('Cedar Island'), place('Long Point')]);
    expect(outcome.ambiguous.map((x) => [x.place.name, x.bodies.sort()])).toEqual([
      ['Cedar Island', ['champlain']],
      ['Long Point', ['george', 'sunapee']],
    ]);
    expect(a.corpusMessages).toBeUndefined();
  });

  it('treats one river’s several mouths as one reference', () => {
    const inlet = landmark('champlain', 'Lamoille River', 'waterway');
    const outlet = {
      ...landmark('champlain', 'Lamoille River', 'waterway'),
      externalIds: ['osm:way/1#out1'],
    };
    applyCorpus(new Map([['champlain', [inlet, outlet]]]), bodies, [place('Lamoille River')]);
    expect([inlet.corpusMessages, outlet.corpusMessages]).toEqual([5, 5]);
  });

  it('never attaches a corpus bay to the village or the business that shares its name', () => {
    const village = landmark('champlain', 'Keeler Bay', 'settlement');
    const beach = landmark('sunapee', 'Leavitt Beach', 'beach');
    const byBody = new Map([
      ['champlain', [village]],
      ['sunapee', [beach]],
    ]);
    const outcome = applyCorpus(byBody, bodies, [
      place('Keeler Bay', { kind: 'bay' }),
      place('Leavitt Beach', { kind: 'bay' }),
    ]);
    expect(village.corpusMessages).toBeUndefined();
    expect(beach.corpusMessages).toBe(5);
    expect(outcome.unmatched.map((p) => p.name)).toEqual(['Keeler Bay']);
  });

  it('indexes a landmark once per spelling, and leaves a body with no name out of the parent test', () => {
    const rock = {
      ...landmark('unnamed', 'Gull Rock', 'other'),
      aliases: ['gull rock', 'Gull Rk'],
    };
    applyCorpus(new Map([['unnamed', [rock]]]), bodies, [
      place('Gull Rock', { parentBody: 'Lake Champlain' }),
    ]);
    expect(rock.corpusMessages).toBeUndefined();
    applyCorpus(new Map([['unnamed', [rock]]]), bodies, [place('Gull Rock')]);
    expect(rock.corpusMessages).toBe(5);
  });
});

describe('corpusNameRecords', () => {
  const lakeBodies = new Map<string, MatchBody>(
    [
      { id: 'champlain', name: 'Lake Champlain', states: ['VT', 'NY'] },
      { id: 'long-me', name: 'Long Pond', states: ['ME'] },
      { id: 'long-nh', name: 'Long Pond', states: ['NH'] },
      { id: 'long-nh2', name: 'Long Pond', states: ['NH'] },
    ].map((b) => [
      b.id,
      {
        ...b,
        polygon: { type: 'Polygon', coordinates: [] },
        bbox: { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 },
        surfaceAreaSqM: 1,
      } as MatchBody,
    ]),
  );

  it('resolves a named lake only when one answers in the corpus’s states, and keeps the choices', () => {
    const records = corpusNameRecords(
      {
        matched: 0,
        unmatched: [
          place('Apple Island', {
            parentBody: 'Lake Champlain',
            states: ['VT'],
            messages: 24,
            aliases: ['Apple Is', 'Lake Champlain (Apple Island)', 'apple island'],
          }),
          place('Big Rock', { parentBody: 'Long Pond', states: ['ME'] }),
          place('Gull Ledge', { parentBody: 'Long Pond', states: ['NH'] }),
          place('Hero’s Welcome'),
          place('Rideau Canal', { parentBody: 'Rideau Canal', states: ['QC'] }),
        ],
        ambiguous: [
          { place: place('Cedar Island'), bodies: ['champlain'] },
          { place: place('Long Point'), bodies: ['long-me', 'long-nh'] },
        ],
      },
      lakeBodies,
    );
    // Busiest first (Apple Island's 24), then by name.
    expect(records.map((r) => [r.name, r.waterBodyId, r.candidateBodyIds, r.alreadyNamed])).toEqual(
      [
        ['Apple Island', 'champlain', undefined, undefined],
        ['Big Rock', 'long-me', undefined, undefined],
        ['Cedar Island', 'champlain', undefined, true],
        ['Gull Ledge', undefined, ['long-nh', 'long-nh2'], undefined],
        ['Hero’s Welcome', undefined, undefined, undefined],
        ['Long Point', undefined, ['long-me', 'long-nh'], true],
        ['Rideau Canal', undefined, undefined, undefined],
      ],
    );
    expect(records[0]).toMatchObject({
      aliases: ['Apple Is'],
      messages: 24,
      parentName: 'Lake Champlain',
      states: ['VT'],
    });
  });

  it('merges two spellings that fold alike on one lake, keeping the busier one’s name', () => {
    const records = corpusNameRecords(
      {
        matched: 0,
        unmatched: [
          place('Saint Albans rock', { messages: 2, skatedMessages: 2, states: ['NY'] }),
          place('St. Albans Rock', {
            messages: 5,
            skatedMessages: 1,
            states: ['VT'],
            aliases: ['SA Rock'],
          }),
        ],
        ambiguous: [],
      },
      lakeBodies,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: 'St. Albans Rock',
      messages: 5,
      skatedMessages: 2,
      states: ['VT', 'NY'],
    });
    // "Saint Albans rock" folds to the name itself, so it is no second spelling.
    expect(records[0]?.aliases).toEqual([]);
  });

  it('skips a body with no name when indexing lakes', () => {
    const withUnnamed = new Map(lakeBodies);
    withUnnamed.set('x', {
      ...(lakeBodies.get('champlain') as MatchBody),
      id: 'x',
      name: undefined,
    });
    const [rec] = corpusNameRecords(
      {
        matched: 0,
        unmatched: [place('Apple Island', { parentBody: 'Lake Champlain' })],
        ambiguous: [],
      },
      withUnnamed,
    );
    expect(rec?.waterBodyId).toBe('champlain');
  });
});
