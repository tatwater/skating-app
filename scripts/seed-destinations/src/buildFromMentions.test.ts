import { describe, expect, it } from 'vitest';
import {
  allStates,
  boostForMessages,
  buildDestinationsFromMentions,
  type MentionRow,
  parseMentionsCsv,
  parseTowns,
  resolveNear,
  SEED_KINDS,
  type TownCentroid,
  tercileThresholds,
  topState,
} from './buildFromMentions';

function row(over: Partial<MentionRow> & { canonicalName: string }): MentionRow {
  return {
    kind: 'lake',
    messages: 5,
    mentions: 5,
    skatedMessages: 1,
    states: 'VT:5',
    towns: '',
    parentBody: '',
    ...over,
  };
}

function town(over: Partial<TownCentroid> & { name: string; state: string }): TownCentroid {
  return { lat: 0, lng: 0, ...over };
}

describe('parseMentionsCsv', () => {
  it('decodes the mentions.csv header and quoted aliases without shifting columns', () => {
    const csv = [
      'canonicalName,kind,messages,mentions,skatedMessages,states,towns,parentBody,firstSeen,lastSeen,aliases',
      'Lake Champlain,lake,349,426,112,VT:405;NY:17;unknown:4,Charlotte(19); Burlington(15),Lake Champlain,2024-01-31T00:00:00+00:00,2026-04-10T00:00:00+00:00,"a, b; c"',
    ].join('\n');
    const rows = parseMentionsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      canonicalName: 'Lake Champlain',
      kind: 'lake',
      messages: 349,
      mentions: 426,
      skatedMessages: 112,
      states: 'VT:405;NY:17;unknown:4',
      towns: 'Charlotte(19); Burlington(15)',
      parentBody: 'Lake Champlain',
    });
  });

  it('throws on a header missing an expected column', () => {
    expect(() => parseMentionsCsv('canonicalName,kind\nFoo,lake')).toThrow(
      /missing expected column/,
    );
  });

  it('defaults a short or non-numeric row instead of shifting or NaN-ing it', () => {
    const csv = [
      'canonicalName,kind,messages,mentions,skatedMessages,states,towns,parentBody',
      // Only two columns present, and the numbers are not numbers.
      'Foo Pond,pond',
      'Bar Pond,pond,many,some,none,VT:1,,',
    ].join('\n');
    const rows = parseMentionsCsv(csv);
    expect(rows[0]).toEqual({
      canonicalName: 'Foo Pond',
      kind: 'pond',
      messages: 0,
      mentions: 0,
      skatedMessages: 0,
      states: '',
      towns: '',
      parentBody: '',
    });
    expect(rows[1]).toMatchObject({ messages: 0, mentions: 0, skatedMessages: 0, states: 'VT:1' });
  });

  it('survives an empty file (header only, or nothing at all)', () => {
    expect(() => parseMentionsCsv('')).toThrow(/missing expected column/);
    expect(
      parseMentionsCsv(
        'canonicalName,kind,messages,mentions,skatedMessages,states,towns,parentBody',
      ),
    ).toEqual([]);
  });
});

describe('topState / allStates', () => {
  it('picks the highest-count real state, ignoring unknown', () => {
    expect(topState('VT:405;NY:17;unknown:4')).toBe('VT');
    expect(topState('unknown:26;VT:8;NH:5;ME:1')).toBe('VT');
  });

  it('tolerates a bare code, an empty code, and a non-numeric count in the states field', () => {
    // "VT" (no colon) counts as VT:0; ":5" has no code and is dropped; "NH:lots" counts as 0.
    // allStates wants a count ≥ 1; topState wants any real code, so a bare "VT" still leads.
    expect(allStates('VT;:5;NH:lots;NY:2')).toEqual(['NY']);
    expect(topState('VT;:5')).toBe('VT');
    expect(topState(':5')).toBeUndefined();
  });

  it('returns undefined when every tally is unknown', () => {
    expect(topState('unknown:12')).toBeUndefined();
    expect(topState('')).toBeUndefined();
  });

  it('lists every real state at least once, unknown excluded, count-descending', () => {
    expect(allStates('VT:5;NH:250;unknown:9;ME:1')).toEqual(['NH', 'VT', 'ME']);
  });
});

describe('parseTowns', () => {
  it('parses name(count) pairs and sorts by count descending', () => {
    expect(parseTowns('Burlington(3); Charlotte(19); North Hero(5)')).toEqual([
      { name: 'Charlotte', count: 19 },
      { name: 'North Hero', count: 5 },
      { name: 'Burlington', count: 3 },
    ]);
  });

  it('keeps a town written without a count, ranked last', () => {
    expect(parseTowns('Charlotte(3); Burlington')).toEqual([
      { name: 'Charlotte', count: 3 },
      { name: 'Burlington', count: 0 },
    ]);
  });

  it('returns nothing for a blank field', () => {
    expect(parseTowns('')).toEqual([]);
  });
});

describe('resolveNear', () => {
  const centroids: TownCentroid[] = [
    town({ name: 'Charlotte', state: 'VT', lat: 44.31, lng: -73.26 }),
    town({ name: 'Burlington', state: 'VT', lat: 44.48, lng: -73.21 }),
    town({ name: 'Charlotte', state: 'NC', lat: 35.23, lng: -80.84 }), // same name, wrong state
  ];

  it('resolves the top town when it matches name + state', () => {
    expect(resolveNear('Charlotte(19); Burlington(15)', 'VT', centroids)).toEqual({
      near: { lat: 44.31, lng: -73.26 },
      viaTownRank: 1,
    });
  });

  it('falls through to the 2nd and 3rd town when earlier ones do not resolve', () => {
    expect(resolveNear('Nowhereville(20); Burlington(15)', 'VT', centroids)).toEqual({
      near: { lat: 44.48, lng: -73.21 },
      viaTownRank: 2,
    });
  });

  it('never matches a same-named town in the wrong state', () => {
    expect(resolveNear('Charlotte(19)', 'NC', centroids.slice(0, 2))).toEqual({});
  });

  it('omits near rather than guessing past the top three towns', () => {
    const near = resolveNear('A(1); B(1); C(1); Burlington(1)', 'VT', centroids);
    expect(near).toEqual({}); // Burlington is ranked 4th — never tried
  });
});

describe('tercileThresholds / boostForMessages', () => {
  it('splits ascending values into three ranks', () => {
    const values = [1, 1, 2, 2, 3, 3, 10, 10, 20];
    const t = tercileThresholds(values);
    expect(boostForMessages(1, t)).toBe(0.1);
    expect(boostForMessages(20, t)).toBe(0.3);
  });

  it('collapses to the single value when there is one row, and grades against it', () => {
    const t = tercileThresholds([7]);
    expect(t).toEqual({ t1: 7, t2: 7 });
    expect(boostForMessages(7, t)).toBe(0.1);
    expect(boostForMessages(8, t)).toBe(0.3);
  });

  it('is stable for an empty input', () => {
    expect(tercileThresholds([])).toEqual({ t1: 0, t2: 0 });
  });
});

describe('SEED_KINDS', () => {
  it('includes every corpus kind meant to seed, excludes other/unknown', () => {
    expect(SEED_KINDS.has('lake')).toBe(true);
    expect(SEED_KINDS.has('pond')).toBe(true);
    expect(SEED_KINDS.has('reservoir')).toBe(true);
    expect(SEED_KINDS.has('bay')).toBe(true);
    expect(SEED_KINDS.has('cove')).toBe(true);
    expect(SEED_KINDS.has('marsh')).toBe(true);
    expect(SEED_KINDS.has('river')).toBe(true);
    expect(SEED_KINDS.has('other')).toBe(false);
  });
});

describe('buildDestinationsFromMentions', () => {
  const towns: TownCentroid[] = [town({ name: 'Charlotte', state: 'VT', lat: 44.31, lng: -73.26 })];

  it('excludes other-kind (landmark), unknown-name, below-threshold, and no-state rows', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Some Beach', kind: 'other' }),
      row({ canonicalName: 'unknown', kind: 'other' }),
      row({ canonicalName: 'Rare Pond', kind: 'pond', messages: 1, skatedMessages: 0 }),
      row({ canonicalName: 'Lake Siljan', kind: 'lake', states: 'unknown:3' }),
      row({ canonicalName: 'Real Lake', kind: 'lake', messages: 3, skatedMessages: 0 }),
    ];
    const { destinations, stats } = buildDestinationsFromMentions(rows, towns);
    expect(destinations.map((d) => d.name)).toEqual(['Real Lake']);
    expect(stats).toMatchObject({
      totalRows: 5,
      included: 1,
      excludedKindOrLandmark: 1,
      excludedUnknownName: 1,
      excludedBelowThreshold: 1,
      excludedNoState: 1,
    });
  });

  it('includes a row via skatedMessages alone even with messages < 2', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Skated Once', kind: 'pond', messages: 1, skatedMessages: 1 }),
    ];
    const { destinations } = buildDestinationsFromMentions(rows, towns);
    expect(destinations).toHaveLength(1);
  });

  it('sets state to the top real state and states[] only when more than one is present', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Multi State', states: 'VT:10;NH:3;unknown:1' }),
      row({ canonicalName: 'Single State', states: 'VT:10' }),
    ];
    const { destinations } = buildDestinationsFromMentions(rows, towns);
    const multi = destinations.find((d) => d.name === 'Multi State');
    const single = destinations.find((d) => d.name === 'Single State');
    expect(multi?.state).toBe('VT');
    expect(multi?.states).toEqual(['VT', 'NH']);
    expect(single?.states).toBeUndefined();
  });

  it('marks a QC top-state row as outside the catalog footprint but still includes it', () => {
    const rows: MentionRow[] = [row({ canonicalName: 'Lac Memphremagog', states: 'QC:10' })];
    const { destinations, stats } = buildDestinationsFromMentions(rows, towns);
    expect(destinations).toHaveLength(1);
    expect(destinations[0]?.notes).toMatch(/^outside catalog footprint; corpus:/);
    expect(stats.qcRows).toBe(1);
  });

  it('resolves near from the top mentioned town, using the row headline state', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Near This', states: 'VT:10', towns: 'Charlotte(9)' }),
    ];
    const { destinations } = buildDestinationsFromMentions(rows, towns);
    expect(destinations[0]?.near).toEqual({ lat: 44.31, lng: -73.26 });
  });

  it('marks kind bay/cove or a set parentBody as a sub-area candidate', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Some Cove', kind: 'cove' }),
      row({ canonicalName: 'Some Bay', kind: 'bay', parentBody: 'Big Lake' }),
      row({ canonicalName: 'Named Lake', kind: 'lake', parentBody: 'Named Parent' }),
      row({ canonicalName: 'Plain Lake', kind: 'lake' }),
    ];
    const { destinations } = buildDestinationsFromMentions(rows, towns);
    const byName = new Map(destinations.map((d) => [d.name, d]));
    expect(byName.get('Some Cove')).toMatchObject({ kind: 'bay' });
    expect(byName.get('Some Cove')?.parent).toBeUndefined();
    expect(byName.get('Some Bay')).toMatchObject({ kind: 'bay', parent: 'Big Lake' });
    expect(byName.get('Named Lake')).toMatchObject({ kind: 'bay', parent: 'Named Parent' });
    expect(byName.get('Plain Lake')?.kind).toBeUndefined();
  });

  it('treats a self-referencing parentBody (name === its own parentBody) as no parent at all', () => {
    // The real mentions.csv has six rows exactly like this — Lake Champlain, Lake Winnipesaukee,
    // Lake Massabesic, Squam Lake, Sebago Lake, Kezar Lake — each `kind: lake` with `parentBody` set
    // to its own name. Taken literally each would enter the sub-area pool as its own sub-area.
    const rows: MentionRow[] = [
      row({ canonicalName: 'Lake Champlain', kind: 'lake', parentBody: 'Lake Champlain' }),
    ];
    const { destinations } = buildDestinationsFromMentions(rows, towns);
    expect(destinations[0]?.kind).toBeUndefined();
    expect(destinations[0]?.parent).toBeUndefined();
  });

  it('special-cases Inland Sea and The Broads by name when parentBody is blank', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Inland Sea', kind: 'lake' }),
      row({ canonicalName: 'The Broads', kind: 'bay' }),
    ];
    const { destinations } = buildDestinationsFromMentions(rows, towns);
    const byName = new Map(destinations.map((d) => [d.name, d]));
    expect(byName.get('Inland Sea')).toMatchObject({ kind: 'bay', parent: 'Lake Champlain' });
    expect(byName.get('The Broads')).toMatchObject({ kind: 'bay', parent: 'Lake Sunapee' });
  });

  it('grades curatedBoost by terciles of messages over the included rows only', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Low', messages: 2 }),
      row({ canonicalName: 'Mid', messages: 5 }),
      row({ canonicalName: 'High', messages: 50 }),
      // Excluded row's huge message count must not skew the tercile thresholds.
      row({ canonicalName: 'Excluded', kind: 'other', messages: 1000 }),
    ];
    const { destinations, stats } = buildDestinationsFromMentions(rows, towns);
    const boosts = new Map(destinations.map((d) => [d.name, d.curatedBoost]));
    expect(boosts.get('Low')).toBeLessThanOrEqual(boosts.get('High') as number);
    expect(stats.boostCounts['0.1'] + stats.boostCounts['0.2'] + stats.boostCounts['0.3']).toBe(3);
  });

  it('sets sources and notes with the corpus tallies', () => {
    const rows: MentionRow[] = [
      row({ canonicalName: 'Notes Check', messages: 7, mentions: 9, skatedMessages: 2 }),
    ];
    const { destinations } = buildDestinationsFromMentions(rows, towns);
    expect(destinations[0]?.sources).toEqual(['community']);
    expect(destinations[0]?.notes).toBe('corpus: 7 messages, 9 mentions, 2 skated');
  });
});
