import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  AERIAL_SCRATCH,
  archiveKey,
  archiveName,
  buildManifestKey,
  buildPrefix,
  indexKey,
  indexName,
  inventoryKey,
  isPilotName,
  manifestKey,
  manifestName,
  parseArchiveKey,
  parseCampaign,
  publishPrefix,
  scratchPaths,
  shardKeys,
} from './keys';

const BUILD = 'naip-20261212';
const PILOT = 'naip-pilot-20261201';
const NAME = 'champlain-nhma';

describe('parseCampaign', () => {
  test('reads a build and a pilot', () => {
    expect(parseCampaign(BUILD)).toEqual({ id: BUILD, date: '20261212', pilot: false });
    expect(parseCampaign(PILOT)).toEqual({ id: PILOT, date: '20261201', pilot: true });
  });

  test.each([
    'naip-2026121',
    'naip-202612121',
    'naip_20261212',
    'naip-summer-20261212',
    'naip-pilot-x-20261212',
    ' naip-20261212',
    '',
  ])('refuses the shape %j', (id) => {
    expect(() => parseCampaign(id)).toThrow(/is not naip-<YYYYMMDD>/);
  });

  test.each(['naip-20260230', 'naip-20261301', 'naip-20260000', 'naip-pilot-20250229'])(
    'refuses %s, a day that is not',
    (id) => {
      expect(() => parseCampaign(id)).toThrow(/which is not a day/);
    },
  );

  test('takes a leap day', () => {
    expect(parseCampaign('naip-20280229').date).toBe('20280229');
  });
});

describe('isPilotName', () => {
  test.each([
    ['champlain-nhma', true],
    ['p1', true],
    ['Champlain', false],
    ['a--b', false],
    ['-a', false],
    ['a/b', false],
    ['', false],
  ])('%j is %s', (name, ok) => {
    expect(isPilotName(name)).toBe(ok);
  });
});

describe('the published three', () => {
  test('a build sits at the production names under dev/naip/', () => {
    expect(archiveName(BUILD)).toBe('naip-summer-20261212.pmtiles');
    expect(indexName(BUILD)).toBe('naip-summer-20261212-cells.json');
    expect(manifestName(BUILD)).toBe('naip-summer-20261212-manifest.json');
    expect(publishPrefix(BUILD)).toBe('dev/naip/');
    expect(archiveKey(BUILD)).toBe('dev/naip/naip-summer-20261212.pmtiles');
    expect(indexKey(BUILD)).toBe('dev/naip/naip-summer-20261212-cells.json');
    expect(manifestKey(BUILD)).toBe('dev/naip/naip-summer-20261212-manifest.json');
  });

  test('a pilot sits under its own name, never at the production names', () => {
    expect(archiveKey(PILOT, NAME)).toBe(`dev/naip/pilot/${NAME}/naip-summer-20261201.pmtiles`);
    expect(indexKey(PILOT, NAME)).toBe(`dev/naip/pilot/${NAME}/naip-summer-20261201-cells.json`);
    expect(manifestKey(PILOT, NAME)).toBe(
      `dev/naip/pilot/${NAME}/naip-summer-20261201-manifest.json`,
    );
  });

  test('two pilots on one day never share a key', () => {
    expect(archiveKey(PILOT, 'a')).not.toBe(archiveKey(PILOT, 'b'));
  });

  test('the index sits beside its archive, the archive suffix swapped', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') }), (d) => {
        if (Number.isNaN(d.getTime())) return;
        const campaign = `naip-${d.toISOString().slice(0, 10).replaceAll('-', '')}`;
        expect(indexKey(campaign)).toBe(archiveKey(campaign).replace(/\.pmtiles$/, '-cells.json'));
        expect(manifestKey(campaign)).toBe(
          archiveKey(campaign).replace(/\.pmtiles$/, '-manifest.json'),
        );
      }),
    );
  });

  test('a pilot campaign without its name is refused', () => {
    expect(() => archiveKey(PILOT)).toThrow(/is a pilot campaign: name the pilot/);
    expect(() => buildPrefix(PILOT)).toThrow(/name the pilot/);
  });

  test('a pilot name on a production campaign is refused', () => {
    expect(() => archiveKey(BUILD, NAME)).toThrow(/needs a pilot campaign/);
    expect(() => shardKeys(BUILD, { z: 11, x: 1, y: 1 }, NAME)).toThrow(/needs a pilot campaign/);
  });

  test('a pilot name that would escape its directory is refused', () => {
    expect(() => archiveKey(PILOT, '../prod')).toThrow(/lowercase words/);
  });
});

describe('parseArchiveKey', () => {
  test('reads back what archiveKey writes', () => {
    expect(parseArchiveKey(archiveKey(BUILD))).toEqual({
      key: archiveKey(BUILD),
      date: '20261212',
      pilot: null,
    });
    expect(parseArchiveKey(archiveKey(PILOT, NAME))).toEqual({
      key: archiveKey(PILOT, NAME),
      date: '20261201',
      pilot: NAME,
    });
  });

  test.each([
    'dev/naip/naip-summer-20261212-cells.json',
    'dev/naip/naip-summer-20261212-manifest.json',
    'prod/naip/naip-summer-20261212.pmtiles',
    'dev/naip/naip-summer-2026121.pmtiles',
    'dev/naip/naip-summer-20261340.pmtiles',
    'dev/naip/pilot/Bad/naip-summer-20261212.pmtiles',
    'dev/naip/pilot/a/b/naip-summer-20261212.pmtiles',
    'naip/build/naip-20261212/manifest.json',
  ])('refuses %s', (key) => {
    expect(() => parseArchiveKey(key)).toThrow();
  });
});

describe('the build prefix', () => {
  test('a build and a pilot each have their own', () => {
    expect(buildPrefix(BUILD)).toBe('naip/build/naip-20261212/');
    expect(buildPrefix(PILOT, NAME)).toBe(`naip/build/pilot/${NAME}/naip-pilot-20261201/`);
    expect(buildManifestKey(BUILD)).toBe('naip/build/naip-20261212/manifest.json');
    expect(buildManifestKey(PILOT, NAME)).toBe(
      `naip/build/pilot/${NAME}/naip-pilot-20261201/manifest.json`,
    );
  });

  test("a work tile's three objects", () => {
    expect(shardKeys(BUILD, { z: 11, x: 610, y: 742 })).toEqual({
      pack: 'naip/build/naip-20261212/shards/11/610/742.pack',
      index: 'naip/build/naip-20261212/shards/11/610/742.idx.json',
      done: 'naip/build/naip-20261212/shards/11/610/742.done.json',
    });
    expect(shardKeys(PILOT, { z: 11, x: 1, y: 2 }, NAME).done).toBe(
      `naip/build/pilot/${NAME}/naip-pilot-20261201/shards/11/1/2.done.json`,
    );
  });

  test('distinct work tiles never share a key', () => {
    fc.assert(
      fc.property(fc.nat(2047), fc.nat(2047), fc.nat(2047), fc.nat(2047), (x1, y1, x2, y2) => {
        fc.pre(x1 !== x2 || y1 !== y2);
        const a = shardKeys(BUILD, { z: 11, x: x1, y: y1 });
        const b = shardKeys(BUILD, { z: 11, x: x2, y: y2 });
        expect(a.pack).not.toBe(b.pack);
      }),
    );
  });

  test('a tile off the work zoom is refused', () => {
    expect(() => shardKeys(BUILD, { z: 12, x: 1, y: 1 })).toThrow(/z11/);
  });
});

describe('inventoryKey', () => {
  test('one gzipped JSONL per state per walk', () => {
    expect(inventoryKey('2026-11-25', 'CT')).toBe('naip/inventory/2026-11-25/ct.jsonl.gz');
  });

  test.each(['20261125', '2026-11-31', '2026-1-05', ''])('refuses the day %j', (day) => {
    expect(() => inventoryKey(day, 'ME')).toThrow(/YYYY-MM-DD/);
  });
});

describe('scratchPaths', () => {
  test("a campaign's files under the package scratch, its log beside them", () => {
    const paths = scratchPaths(BUILD, '/s');
    expect(paths).toEqual({
      dir: '/s/naip-20261212',
      manifest: '/s/naip-20261212/manifest.json',
      inventory: '/s/naip-20261212/inventory',
      report: '/s/naip-20261212/report',
      log: '/s/run-naip-20261212.log',
    });
  });

  test("defaults to the package's own gitignored .scratch", () => {
    expect(AERIAL_SCRATCH.endsWith(join('scripts', 'aerial', '.scratch'))).toBe(true);
    expect(scratchPaths(BUILD).dir).toBe(join(AERIAL_SCRATCH, BUILD));
  });

  test('refuses a campaign that is not one', () => {
    expect(() => scratchPaths('../etc')).toThrow();
  });
});
