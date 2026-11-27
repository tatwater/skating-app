import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { quarterQuadAt } from './naipGrid';
import {
  AERIAL_ENTRY_POINT,
  AERIAL_STAGES,
  type AerialRunOptions,
  aerialRebuildCommand,
  formatNaipCreditRange,
  isCalendarDay,
  NAIP_CELL_INDEX_VERSION,
  NAIP_TILING_VERSION,
  type NaipCellIndex,
  naipCreditRange,
  naipExclusionsHash,
  naipFoliageStrikesHash,
  naipFramesToCut,
  naipIndexUrl,
  naipWorkTileInputHash,
  parseNaipCellIndex,
  sha256Hex,
} from './naipManifest';
import { NAIP_STATES, type NaipExclusion, type NaipFoliageStrike } from './naipSelection';

const ARCHIVE = 'naip-summer-20261212.pmtiles';

/** The format's own example (§2.7). */
const EXAMPLE = {
  version: 1,
  archive: ARCHIVE,
  flights: [
    { date: '2023-06-21', gsd: 0.3, state: 'VT' },
    { date: '2022-07-07', gsd: 0.6, state: 'NY' },
  ],
  cells: { '4407339ne': [0], '4407336nw': [0, 1] },
};

describe('parseNaipCellIndex', () => {
  test("reads the format's example", () => {
    expect(parseNaipCellIndex(EXAMPLE, ARCHIVE)).toEqual(EXAMPLE);
  });

  test('keeps only what the format names', () => {
    const extra = {
      ...EXAMPLE,
      note: 'x',
      flights: [{ ...EXAMPLE.flights[0], extra: 1 }],
      cells: { '4407339ne': [0] },
    };
    expect(parseNaipCellIndex(extra, ARCHIVE)).toEqual({
      version: 1,
      archive: ARCHIVE,
      flights: [EXAMPLE.flights[0]],
      cells: { '4407339ne': [0] },
    });
  });

  test.each<[string, unknown, RegExp]>([
    ['not an object', [], /is not an object/],
    ['null', null, /is not an object/],
    ['another version', { ...EXAMPLE, version: 2 }, /version 2, not 1/],
    [
      "another archive's index",
      { ...EXAMPLE, archive: 'naip-summer-20250101.pmtiles' },
      /names "naip-summer-20250101.pmtiles"/,
    ],
    ['no flights', { ...EXAMPLE, flights: undefined }, /has no flights/],
    [
      'a flight that is not an object',
      { ...EXAMPLE, flights: ['2023-06-21'] },
      /flight 0 is not an object/,
    ],
    [
      'a flight with no real day',
      { ...EXAMPLE, flights: [{ date: '2023-02-30', gsd: 0.3, state: 'VT' }] },
      /flight 0 has no real day/,
    ],
    [
      'a program year for a day',
      { ...EXAMPLE, flights: [{ date: '2023', gsd: 0.3, state: 'VT' }] },
      /no real day/,
    ],
    [
      'a flight with no resolution',
      { ...EXAMPLE, flights: [{ date: '2023-06-21', gsd: 0, state: 'VT' }] },
      /no resolution/,
    ],
    [
      'a flight of another state',
      { ...EXAMPLE, flights: [{ date: '2023-06-21', gsd: 0.3, state: 'NJ' }] },
      /no state of the seven/,
    ],
    ['no cells', { ...EXAMPLE, cells: [] }, /has no cells/],
    ['a cell that is not a key', { ...EXAMPLE, cells: { foo: [0] } }, /a cell that isn't one/],
    [
      'an entry with no flight',
      { ...EXAMPLE, cells: { '4407339ne': [] } },
      /dates no flight for 4407339ne/,
    ],
    ['an entry that is not a list', { ...EXAMPLE, cells: { '4407339ne': 0 } }, /dates no flight/],
    [
      'an out-of-range flight',
      { ...EXAMPLE, cells: { '4407339ne': [2] } },
      /points 4407339ne at no flight: 2/,
    ],
    ['a fractional index', { ...EXAMPLE, cells: { '4407339ne': [0.5] } }, /at no flight/],
    ['a negative index', { ...EXAMPLE, cells: { '4407339ne': [-1] } }, /at no flight/],
    [
      'a flight named twice',
      { ...EXAMPLE, cells: { '4407339ne': [1, 1] } },
      /names flight 1 twice/,
    ],
  ])('refuses %s', (_, json, message) => {
    expect(() => parseNaipCellIndex(json, ARCHIVE)).toThrow(message);
  });
});

describe('naipIndexUrl', () => {
  test.each([
    [
      'https://x.r2.dev/dev/naip/naip-summer-20261212.pmtiles',
      'https://x.r2.dev/dev/naip/naip-summer-20261212-cells.json',
    ],
    ['/local/naip-summer-20261212.pmtiles?v=2#f', '/local/naip-summer-20261212-cells.json?v=2#f'],
    ['naip.pmtiles#x.pmtiles', 'naip-cells.json#x.pmtiles'],
  ])('%s → %s', (url, index) => {
    expect(naipIndexUrl(url)).toBe(index);
  });

  test.each([
    'https://x/naip.mbtiles',
    'https://x/naip.pmtiles.json',
    '.pmtiles',
    '',
    'https://x/a?b.pmtiles',
  ])('refuses %j', (url) => {
    expect(() => naipIndexUrl(url)).toThrow(/not a summer aerial archive URL/);
  });
});

// ── The credit's range (§4.2) ────────────────────────────────────────────────────────────────────

const dayArb = fc
  .date({
    min: new Date('2011-01-01T00:00:00Z'),
    max: new Date('2026-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));
const keyArb = fc
  .record({
    lat: fc.double({ min: 40.5, max: 47.4, noNaN: true }),
    lng: fc.double({ min: -79.7, max: -67, noNaN: true }),
  })
  .map(({ lat, lng }) => quarterQuadAt(lat, lng));
const indexArb: fc.Arbitrary<NaipCellIndex> = fc
  .array(
    fc.record({
      date: dayArb,
      gsd: fc.constantFrom(0.3, 0.6),
      state: fc.constantFrom(...NAIP_STATES),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .chain((flights) =>
    fc
      .dictionary(
        keyArb,
        fc.uniqueArray(fc.nat(flights.length - 1), { minLength: 1, maxLength: flights.length }),
        { maxKeys: 12 },
      )
      .map((cells) => ({ version: NAIP_CELL_INDEX_VERSION, archive: ARCHIVE, flights, cells })),
  );

describe('naipCreditRange', () => {
  test('is null exactly when no key is indexed; otherwise it holds every flight and attains both ends', () => {
    fc.assert(
      fc.property(
        indexArb,
        fc.array(keyArb, { maxLength: 10 }),
        fc.boolean(),
        (index, extra, withIndexed) => {
          const keys = withIndexed ? [...extra, ...Object.keys(index.cells).slice(0, 3)] : extra;
          const range = naipCreditRange(index, keys);
          const dates = keys.flatMap((k) =>
            Object.hasOwn(index.cells, k)
              ? (index.cells[k] as number[]).map((i) => index.flights[i]?.date as string)
              : [],
          );
          if (dates.length === 0) {
            expect(range).toBeNull();
            return;
          }
          expect(range).not.toBeNull();
          const { from, to } = range as { from: string; to: string };
          for (const d of dates) {
            expect(d >= from && d <= to).toBe(true);
          }
          expect(dates).toContain(from);
          expect(dates).toContain(to);
        },
      ),
    );
  });

  test("dates every cell under the view, not the first one's flight", () => {
    const index = parseNaipCellIndex(EXAMPLE, ARCHIVE);
    expect(naipCreditRange(index, ['4407339ne', '4407336nw'])).toEqual({
      from: '2022-07-07',
      to: '2023-06-21',
    });
    expect(naipCreditRange(index, ['4407339ne'])).toEqual({ from: '2023-06-21', to: '2023-06-21' });
    expect(naipCreditRange(index, new Set(['4407336nw', 'nope']))).toEqual({
      from: '2022-07-07',
      to: '2023-06-21',
    });
    expect(naipCreditRange(index, [])).toBeNull();
    // An inherited name is not a cell.
    expect(naipCreditRange(index, ['constructor', 'toString'])).toBeNull();
  });
});

describe('formatNaipCreditRange', () => {
  test.each([
    [{ from: '2023-06-21', to: '2023-06-21' }, 'Jun 2023'],
    [{ from: '2023-06-01', to: '2023-06-30' }, 'Jun 2023'],
    [{ from: '2021-06-14', to: '2023-08-02' }, 'Jun 2021 – Aug 2023'],
    [{ from: '2023-10-02', to: '2023-10-02' }, 'Oct 2023'],
    [{ from: '2023-01-31', to: '2023-12-01' }, 'Jan 2023 – Dec 2023'],
  ])('%j reads %j', (range, words) => {
    expect(formatNaipCreditRange(range)).toBe(words);
  });

  test.each([
    [{ from: '2023-08-01', to: '2023-06-01' }, /runs forward/],
    [{ from: '2023-13-01', to: '2023-13-01' }, /not a YYYY-MM-DD day/],
    [{ from: '2023', to: '2023-06-01' }, /not a YYYY-MM-DD day/],
  ])('refuses %j', (range, message) => {
    expect(() => formatNaipCreditRange(range)).toThrow(message);
  });
});

describe('isCalendarDay', () => {
  test.each([
    ['2024-02-29', true],
    ['2023-02-29', false],
    ['2023-00-10', false],
    ['2023-6-1', false],
    ['20230601', false],
  ])('%s: %s', (day, ok) => {
    expect(isCalendarDay(day)).toBe(ok);
  });
});

// ── The hashes ───────────────────────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  test.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('the FIPS 180-4 vector %j', (text, hex) => {
    expect(sha256Hex(text)).toBe(hex);
  });

  test("agrees with node's, across block boundaries and multi-byte text (a property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      }),
    );
  });
});

describe('naipFramesToCut', () => {
  test('the pick alone, unless it is partial or the cell is on a state line', () => {
    const c = { pick: 'p', stack: ['a', 'b'], partial: false, states: ['VT'] };
    expect(naipFramesToCut(c)).toEqual(['p']);
    expect(naipFramesToCut({ ...c, partial: true })).toEqual(['p', 'a', 'b']);
    expect(naipFramesToCut({ ...c, states: ['NY', 'VT'] })).toEqual(['p', 'a', 'b']);
    expect(naipFramesToCut({ ...c, stack: [], partial: true })).toEqual(['p']);
  });
});

describe('naipWorkTileInputHash', () => {
  const cell = (
    key: string,
    pick: string,
    stack: string[] = [],
    partial = false,
    states: string[] = ['VT'],
  ) => ({ key, pick, stack, partial, states });
  const cells = [cell('4407236se', 'a', ['b', 'c']), cell('4407236sw', 'd', [], true)];
  const base = naipWorkTileInputHash('11/610/742', cells, 1);

  test("is a hex SHA-256 that doesn't depend on the cells' order", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(naipWorkTileInputHash('11/610/742', [...cells].reverse(), 1)).toBe(base);
  });

  test('changes with anything that decides the pixels', () => {
    const variants = [
      naipWorkTileInputHash('11/610/743', cells, 1),
      naipWorkTileInputHash('11/610/742', cells, 2),
      naipWorkTileInputHash(
        '11/610/742',
        [cell('4407236se', 'b', ['a', 'c']), cells[1] as never],
        1,
      ),
      naipWorkTileInputHash(
        '11/610/742',
        [cell('4407236se', 'a', ['c', 'b']), cells[1] as never],
        1,
      ),
      naipWorkTileInputHash('11/610/742', [cell('4407236se', 'a', ['b']), cells[1] as never], 1),
      naipWorkTileInputHash(
        '11/610/742',
        [cells[0] as never, cell('4407236sw', 'd', [], false)],
        1,
      ),
      naipWorkTileInputHash('11/610/742', [cells[0] as never], 1),
      // A cell that becomes a border cell has its fallbacks cut: other pixels, another hash.
      naipWorkTileInputHash(
        '11/610/742',
        [cell('4407236se', 'a', ['b', 'c'], false, ['NY', 'VT']), cells[1] as never],
        1,
      ),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  test('covers every input of the frames the worker cuts (a property)', () => {
    // Two cells that differ in what the worker cuts never hash alike; a change that cuts the same
    // frames from the same pick, stack and partial (a border cell gaining a third state) keeps it.
    const ids = fc.constantFrom('a', 'b', 'c', 'd');
    const arb = fc.record({
      pick: ids,
      stack: fc.uniqueArray(ids, { maxLength: 3 }),
      partial: fc.boolean(),
      states: fc.subarray(['MA', 'NH', 'NY', 'VT'], { minLength: 1 }),
    });
    fc.assert(
      fc.property(arb, arb, (x, y) => {
        const hx = naipWorkTileInputHash('11/610/742', [{ key: '4407236se', ...x }], 1);
        const hy = naipWorkTileInputHash('11/610/742', [{ key: '4407236se', ...y }], 1);
        const cutX = JSON.stringify(naipFramesToCut(x));
        const cutY = JSON.stringify(naipFramesToCut(y));
        if (cutX !== cutY) return hx !== hy;
        const same =
          x.pick === y.pick &&
          x.partial === y.partial &&
          JSON.stringify(x.stack) === JSON.stringify(y.stack);
        return same === (hx === hy);
      }),
    );
  });

  test('refuses a work tile that lists a cell twice', () => {
    expect(() =>
      naipWorkTileInputHash('11/610/742', [cells[0] as never, cells[0] as never], 1),
    ).toThrow(/listed twice/);
  });

  test('names the tiling version it hashes', () => {
    expect(NAIP_TILING_VERSION).toBe(1);
  });
});

describe('naipFoliageStrikesHash', () => {
  const review = { reason: 'turned', reviewedBy: 'founder', reviewedOn: '2026-11-27' } as const;
  const day: NaipFoliageStrike = {
    flight: { state: 'ME', acquired: '2023-09-27' },
    keep: ['b', 'a'],
    ...review,
  };
  const one: NaipFoliageStrike = { itemId: 'x', ...review };

  test("hashes the list, not its order, nor the order of a day's keeps, nor a note", () => {
    expect(naipFoliageStrikesHash([day, one])).toBe(naipFoliageStrikesHash([one, day]));
    expect(naipFoliageStrikesHash([{ ...day, keep: ['a', 'b'] }])).toBe(
      naipFoliageStrikesHash([day]),
    );
    expect(naipFoliageStrikesHash([{ ...one, note: 'brown' }])).toBe(naipFoliageStrikesHash([one]));
    expect(naipFoliageStrikesHash([])).toBe(sha256Hex('[]'));
  });

  test('changes with any field that strikes differently, or with who reviewed it', () => {
    const hashes = [
      naipFoliageStrikesHash([day, one]),
      naipFoliageStrikesHash([day]),
      naipFoliageStrikesHash([{ ...day, keep: ['a'] }, one]),
      naipFoliageStrikesHash([{ ...day, flight: { state: 'NH', acquired: '2023-09-27' } }, one]),
      naipFoliageStrikesHash([{ ...day, flight: { state: 'ME', acquired: '2023-09-28' } }, one]),
      naipFoliageStrikesHash([day, { ...one, itemId: 'y' }]),
      naipFoliageStrikesHash([day, { ...one, reviewedBy: 'proposed' }]),
      naipFoliageStrikesHash([{ ...day, reviewedOn: '2026-11-28' }, one]),
      // A day that keeps the one frame is not the frame struck.
      naipFoliageStrikesHash([{ itemId: 'ME 2023-09-27', ...review }]),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('naipExclusionsHash', () => {
  const a: NaipExclusion = {
    itemId: 'a',
    reason: 'glare',
    reviewedBy: 'founder',
    reviewedOn: '2026-11-26',
  };
  const b: NaipExclusion = {
    itemId: 'b',
    reason: 'cloud',
    reviewedBy: 'builder',
    reviewedOn: '2026-11-26',
  };

  test('hashes the list, not its order', () => {
    expect(naipExclusionsHash([a, b])).toBe(naipExclusionsHash([b, a]));
    expect(naipExclusionsHash([])).toBe(sha256Hex('[]'));
    const twice = { ...a, reason: 'cloud' as const };
    expect(naipExclusionsHash([a, twice, b])).toBe(naipExclusionsHash([b, twice, a]));
  });

  test('changes with any field of any entry', () => {
    const hashes = [
      naipExclusionsHash([a, b]),
      naipExclusionsHash([a]),
      naipExclusionsHash([{ ...a, reason: 'cloud' }, b]),
      naipExclusionsHash([{ ...a, reviewedBy: 'builder' }, b]),
      naipExclusionsHash([{ ...a, reviewedOn: '2026-11-27' }, b]),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

// ── The one command ─────────────────────────────────────────────────────────────────────────────

describe('aerialRebuildCommand', () => {
  test('the July offer’s line: the campaign and its flags, from the repo root', () => {
    expect(
      aerialRebuildCommand('naip-20270712', { fromCurrent: true, states: ['VT', 'NH', 'VT'] }),
    ).toBe(`${AERIAL_ENTRY_POINT} naip-20270712 --states NH,VT --from-current`);
  });

  test('every flag, in a fixed order; `all` is the default and left out', () => {
    expect(
      aerialRebuildCommand('naip-pilot-20261201', {
        stage: 'select',
        cells: '/tmp/pilot cells.txt',
        pilot: 'champlain-nhma-me-ny',
        dryRun: true,
      }),
    ).toBe(
      "scripts/aerial/run-aerial.sh naip-pilot-20261201 --stage select --cells '/tmp/pilot cells.txt' --pilot champlain-nhma-me-ny --dry-run",
    );
    expect(aerialRebuildCommand('naip-20270712', { stage: 'all', states: [] })).toBe(
      'scripts/aerial/run-aerial.sh naip-20270712',
    );
    expect(
      aerialRebuildCommand('naip-20270712', { stage: 'cleanup', old: "dev/naip/it's.pmtiles" }),
    ).toBe(
      `scripts/aerial/run-aerial.sh naip-20270712 --stage cleanup --old 'dev/naip/it'\\''s.pmtiles'`,
    );
    expect(
      aerialRebuildCommand('naip-20270712', {
        stage: 'cleanup',
        old: 'dev/naip/naip-summer-20261212.pmtiles',
        liveSince: '2027-07-20',
      }),
    ).toBe(
      'scripts/aerial/run-aerial.sh naip-20270712 --stage cleanup --old dev/naip/naip-summer-20261212.pmtiles --live-since 2027-07-20',
    );
    expect(aerialRebuildCommand('naip-20270712', { cells: '' })).toBe(
      "scripts/aerial/run-aerial.sh naip-20270712 --cells ''",
    );
  });

  test.each<[string, AerialRunOptions, RegExp]>([
    ['naip-2027071', {}, /is not naip-<YYYYMMDD>/],
    ['naip-20270712; rm -rf /', {}, /is not naip-<YYYYMMDD>/],
    ['naip-pilot-20270712', { pilot: 'Champlain NH' }, /lowercase words/],
    ['naip-20270712', { stage: 'deploy' as never }, /unknown stage/],
  ])('refuses %j %j', (campaign, options, message) => {
    expect(() => aerialRebuildCommand(campaign, options)).toThrow(message);
  });

  test('knows every stage', () => {
    for (const stage of AERIAL_STAGES)
      expect(() => aerialRebuildCommand('naip-20270712', { stage })).not.toThrow();
  });
});
