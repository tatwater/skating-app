import { describe, expect, it } from 'vitest';
import {
  CleanupRefusal,
  envValue,
  LIVE_GRACE_DAYS,
  parseLiveSince,
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
    // Uploaded ten days ago, published the next day: live since the end of 2027-08-11, 8 days.
    liveSince: parseLiveSince('2027-08-11'),
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
      liveFrom: at(8),
    });
  });

  it('refuses the newest key', () => {
    expect(() =>
      plan({ old: 'dev/naip/naip-summer-20261212.pmtiles', listing: listing.slice(0, 3) }),
    ).toThrow(
      new CleanupRefusal(
        'cleanup.newest',
        'dev/naip/naip-summer-20261212.pmtiles is the newest archive: it is never deleted',
      ),
    );
  });

  it('counts the week from when the replacement went live, never from its upload', () => {
    // Uploaded 30 days ago, published today: the old archive's cached clients have had no week.
    const old = listing.map((o) => (o.key.includes('20270801') ? { ...o, modified: at(30) } : o));
    expect(() => plan({ listing: old, liveSince: parseLiveSince('2027-08-20') })).toThrow(
      /has been live 0\.0 days \(since 2027-08-21T00:00:00\.000Z\): .* stays until it has been live a week/,
    );
    // A bare day counts from its end; an ISO time from itself.
    expect(() => plan({ liveSince: parseLiveSince('2027-08-13') })).toThrow(/live 6\.0 days/);
    expect(plan({ liveSince: parseLiveSince('2027-08-12') }).liveFrom).toEqual(at(LIVE_GRACE_DAYS));
    expect(() => plan({ liveSince: parseLiveSince('2027-08-13T12:00:00Z') })).toThrow(
      /live 6\.5 days/,
    );
    expect(plan({ liveSince: parseLiveSince('2027-08-12T20:00:00-04:00') }).liveFrom).toEqual(
      at(LIVE_GRACE_DAYS),
    );
  });

  it('refuses without --live-since, with one in the future, or one before the upload', () => {
    expect(() => plan({ liveSince: null })).toThrow(/cleanup needs --live-since <YYYY-MM-DD>/);
    expect(() => plan({ liveSince: parseLiveSince('2027-08-21') })).toThrow(/is in the future/);
    expect(() => plan({ liveSince: parseLiveSince('2027-08-20T00:00:01Z') })).toThrow(
      /is in the future/,
    );
    // Uploaded ten days ago (2027-08-10T00:00Z): the day before can't have been live.
    expect(() => plan({ liveSince: parseLiveSince('2027-08-09') })).toThrow(
      /is before .* was uploaded/,
    );
    expect(() => plan({ liveSince: parseLiveSince('2027-08-09T23:59:00Z') })).toThrow(
      /is before .* was uploaded/,
    );
    // The upload's own day is the earliest it can have gone live.
    expect(plan({ liveSince: parseLiveSince('2027-08-10') }).liveFrom).toEqual(at(9));
  });

  it('refuses while the replacement has never been live: no web env file points at it', () => {
    for (const liveArchiveUrls of [
      [],
      ['https://tiles.example/dev/naip/naip-summer-20991231.pmtiles'],
    ]) {
      expect(() => plan({ liveArchiveUrls })).toThrow(
        /naip-summer-20270801\.pmtiles is not the archive the web points at .* it has never been live/,
      );
    }
  });

  it('reads --live-since as a real day or an ISO time with its offset, nothing else', () => {
    expect(parseLiveSince('2027-08-11')).toEqual({
      from: new Date('2027-08-11T00:00:00Z'),
      to: new Date('2027-08-12T00:00:00Z'),
    });
    const t = new Date('2027-08-11T22:30:00Z');
    expect(parseLiveSince('2027-08-11T18:30:00-04:00')).toEqual({ from: t, to: t });
    for (const bad of ['2027-02-30', '2027-8-11', 'yesterday', '2027-08-11T18:30:00', '']) {
      expect(() => parseLiveSince(bad)).toThrow(CleanupRefusal);
    }
  });

  it('refuses the archive the web points at', () => {
    expect(() =>
      plan({
        liveArchiveUrls: ['https://tiles.example/dev/naip/naip-summer-20261212.pmtiles?v=1'],
      }),
    ).toThrow('is the archive the web points at');
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
        liveSince: null,
        now: NOW,
      }).deletePrefix,
    ).toBe('naip/build/pilot/champlain/naip-pilot-20261201/');
  });

  it('a pilot, never published, counts its week from its upload and takes no --live-since', () => {
    const pilot = (modifiedDaysAgo: number, liveSince: ReturnType<typeof parseLiveSince> | null) =>
      planCleanup({
        campaign: 'naip-pilot-20261212',
        pilot: 'champlain',
        old: 'dev/naip/pilot/champlain/naip-summer-20261201.pmtiles',
        listing: [
          { key: 'dev/naip/pilot/champlain/naip-summer-20261201.pmtiles', modified: at(30) },
          {
            key: 'dev/naip/pilot/champlain/naip-summer-20261212.pmtiles',
            modified: at(modifiedDaysAgo),
          },
        ],
        liveArchiveUrls: [],
        liveSince,
        now: NOW,
      });
    expect(pilot(7, null).liveFrom).toEqual(at(7));
    expect(() => pilot(6.5, null)).toThrow(/has been live 6\.5 days/);
    expect(() => pilot(20, parseLiveSince('2027-08-01'))).toThrow(/--live-since is for a build/);
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
