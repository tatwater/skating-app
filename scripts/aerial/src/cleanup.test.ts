import { describe, expect, it } from 'vitest';
import {
  CleanupRefusal,
  envValue,
  LIVE_GRACE_DAYS,
  planCleanup,
  WEB_ENV_FILES,
  webArchiveUrls,
} from './cleanup';

const DAY = 86_400_000;
const NOW = new Date('2027-08-20T00:00:00Z');
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

const listing = [
  { key: 'dev/naip/naip-summer-20261212.pmtiles', modified: at(250) },
  { key: 'dev/naip/naip-summer-20261212-cells.json', modified: at(250) },
  { key: 'dev/naip/naip-summer-20261212-manifest.json', modified: at(250) },
  { key: 'dev/naip/naip-summer-20270801.pmtiles', modified: at(10) },
  { key: 'dev/naip/naip-summer-20270801-cells.json', modified: at(10) },
];

const plan = (patch: Partial<Parameters<typeof planCleanup>[0]> = {}) =>
  planCleanup({
    campaign: 'naip-20270801',
    pilot: null,
    old: 'dev/naip/naip-summer-20261212.pmtiles',
    listing,
    liveArchiveUrls: ['https://tiles.example/dev/naip/naip-summer-20270801.pmtiles'],
    now: NOW,
    ...patch,
  });

describe('cleanup', () => {
  it('deletes the old archive’s three objects and its build prefix, nothing else', () => {
    expect(plan()).toEqual({
      deleteKeys: [
        'dev/naip/naip-summer-20261212.pmtiles',
        'dev/naip/naip-summer-20261212-cells.json',
        'dev/naip/naip-summer-20261212-manifest.json',
      ],
      deletePrefix: 'naip/build/naip-20261212/',
      replacedBy: 'dev/naip/naip-summer-20270801.pmtiles',
      replacedAt: at(10),
    });
  });

  it('refuses the newest key', () => {
    expect(() =>
      plan({ old: 'dev/naip/naip-summer-20261212.pmtiles', listing: listing.slice(0, 3) }),
    ).toThrow(
      new CleanupRefusal(
        'dev/naip/naip-summer-20261212.pmtiles is the newest archive: it is never deleted',
      ),
    );
  });

  it('refuses anything whose replacement has been live under a week', () => {
    const fresh = listing.map((o) =>
      o.key.includes('20270801') ? { ...o, modified: at(LIVE_GRACE_DAYS - 0.5) } : o,
    );
    expect(() => plan({ listing: fresh })).toThrow(
      /written 6\.5 days ago: .* stays until it has been live a week/,
    );
    const week = listing.map((o) =>
      o.key.includes('20270801') ? { ...o, modified: at(LIVE_GRACE_DAYS) } : o,
    );
    expect(plan({ listing: week }).replacedAt).toEqual(at(7));
  });

  it('refuses the archive the web points at', () => {
    expect(() =>
      plan({
        liveArchiveUrls: ['https://tiles.example/dev/naip/naip-summer-20261212.pmtiles?v=1'],
      }),
    ).toThrow('is the archive the web points at');
    expect(plan({ liveArchiveUrls: [] }).deleteKeys).toHaveLength(3);
  });

  it('refuses it named in any of the web’s env files, and by its file name whatever the path', () => {
    expect(() =>
      plan({
        liveArchiveUrls: [
          'https://tiles.example/dev/naip/naip-summer-20270801.pmtiles',
          'https://tiles.example/dev/naip/naip-summer-20261212.pmtiles',
        ],
      }),
    ).toThrow('is the archive the web points at');
    // A custom domain mapped onto the publish prefix serves the same object at a shorter path.
    expect(() =>
      plan({ liveArchiveUrls: ['https://aerial.example/naip-summer-20261212.pmtiles#x'] }),
    ).toThrow('is the archive the web points at');
  });

  it('refuses when what the web points at can’t be read, rather than skip the check', () => {
    expect(() => plan({ liveArchiveUrls: undefined })).toThrow(
      /can be read, so what the web points at .* can't be told/,
    );
  });

  it('reads the web’s env the way Vite does: .env.local as well as .env', () => {
    const NAME = 'VITE_NAIP_PMTILES_URL';
    const files: Record<string, string> = {
      '.env': 'OTHER=1\n',
      '.env.local': `${NAME}=https://tiles.example/dev/naip/naip-summer-20261212.pmtiles\n`,
    };
    const read = (name: string) => files[name] ?? null;
    expect(WEB_ENV_FILES).toContain('.env.local');
    // The operator's checkout keeps it in .env.local; .env alone said "nothing is live".
    expect(webArchiveUrls(read)).toEqual([
      'https://tiles.example/dev/naip/naip-summer-20261212.pmtiles',
    ]);
    expect(() => plan({ liveArchiveUrls: webArchiveUrls(read) })).toThrow(
      'is the archive the web points at',
    );
    expect(webArchiveUrls((name) => (name === '.env' ? 'OTHER=1\n' : null))).toEqual([]);
    expect(webArchiveUrls(() => null)).toBeUndefined();
  });

  it('refuses a swapped pair, its own archive, a key not there, a missing replacement, a pilot mismatch', () => {
    expect(() => plan({ campaign: 'naip-20261212' })).toThrow("this build's own archive");
    expect(() => plan({ campaign: 'naip-20261101' })).toThrow('is not older than');
    expect(() => plan({ old: 'dev/naip/naip-summer-20260101.pmtiles' })).toThrow(
      'nothing to delete',
    );
    expect(() => plan({ campaign: 'naip-20270901' })).toThrow(
      'which replaces it, is not in the bucket',
    );
    expect(() => plan({ pilot: 'champlain', campaign: 'naip-pilot-20270801' })).toThrow(
      'is a production key',
    );
    expect(() => plan({ old: 'dev/naip/pilot/champlain/naip-summer-20261212.pmtiles' })).toThrow(
      "is pilot champlain's, this run is production",
    );
  });

  it('cleans a pilot inside its own prefix', () => {
    const pilotListing = [
      { key: 'dev/naip/pilot/champlain/naip-summer-20261201.pmtiles', modified: at(30) },
      { key: 'dev/naip/pilot/champlain/naip-summer-20261212.pmtiles', modified: at(20) },
      { key: 'dev/naip/naip-summer-20991231.pmtiles', modified: at(1) },
    ];
    expect(
      planCleanup({
        campaign: 'naip-pilot-20261212',
        pilot: 'champlain',
        old: 'dev/naip/pilot/champlain/naip-summer-20261201.pmtiles',
        listing: pilotListing,
        liveArchiveUrls: [],
        now: NOW,
      }).deletePrefix,
    ).toBe('naip/build/pilot/champlain/naip-pilot-20261201/');
  });

  it('reads an env value by name without printing it', () => {
    const text = [
      'OTHER=1',
      'VITE_NAIP_PMTILES_URL=https://a.example/x.pmtiles # old',
      'export VITE_NAIP_PMTILES_URL="https://b.example/y.pmtiles"',
    ].join('\n');
    expect(envValue(text, 'VITE_NAIP_PMTILES_URL')).toBe('https://b.example/y.pmtiles');
    expect(envValue('VITE_NAIP_PMTILES_URL=', 'VITE_NAIP_PMTILES_URL')).toBeNull();
    expect(envValue("VITE_NAIP_PMTILES_URL='z", 'VITE_NAIP_PMTILES_URL')).toBe('z');
    expect(envValue('A=1', 'VITE_NAIP_PMTILES_URL')).toBeNull();
  });
});
