import { describe, expect, it } from 'vitest';

import {
  type FirstSkate,
  firstSkateWords,
  type HomeSummary,
  iceWatchFromRecord,
  iceWatchWords,
  imageryWords,
  isoDay,
  seasonFromSummary,
  winterWords,
} from './seasonFacts';

const day = (m: number, d: number, y = 2026) => new Date(y, m, d).getTime();

describe('the ice watch', () => {
  it('reads a season record: open since its night, by how many sentinels', () => {
    const watch = iceWatchFromRecord(
      {
        opensOn: '2026-10-03',
        openedBy: ['sentinel'],
        opening: { sentinels: [{}, {}] },
        sentinels: [{}, {}, {}],
      },
      day(9, 1),
    );
    expect(watch).toEqual({
      state: 'open',
      since: day(9, 3),
      sentinels: 2,
      of: 3,
      byRegion: false,
    });
    expect(iceWatchWords(watch)).toEqual({
      value: 'Open',
      unit: 'Since 3 Oct',
      tone: 'default',
      sub: 'Opened by 2 of 3 sentinels',
    });
  });

  it('says the region opened it, alone or beside the sentinels', () => {
    const region = iceWatchFromRecord({ opensOn: '2026-10-05', openedBy: ['corpus'] }, 0);
    expect(iceWatchWords(region).sub).toBe('Opened by the region’s bodies');
    const both = iceWatchFromRecord(
      {
        opensOn: '2026-10-05',
        openedBy: ['sentinel', 'corpus'],
        opening: { sentinels: [{}] },
        sentinels: [{}, {}, {}],
      },
      0,
    );
    expect(iceWatchWords(both).sub).toBe('Opened by 1 of 3 sentinels and the region');
  });

  it('waits before any night opens it, and reads closed once the thaw run ends it', () => {
    expect(iceWatchWords(iceWatchFromRecord(null, day(9, 1)))).toEqual({
      value: 'Waiting',
      tone: 'dim',
      sub: 'Counting nights from 1 Oct',
    });
    const closed = iceWatchFromRecord(
      { opensOn: '2026-10-03', openedBy: ['sentinel'], closesOn: '2027-04-12' },
      0,
    );
    expect(closed).toEqual({ state: 'closed', since: day(3, 12, 2027) });
    expect(iceWatchWords(closed).unit).toBe('Since 12 Apr');
  });

  it('reads a record’s date as that calendar day, local', () => {
    expect(new Date(isoDay('2026-10-03')).getDate()).toBe(3);
    expect(new Date(isoDay('2026-10-03')).getHours()).toBe(0);
  });
});

describe('winter, region-wide', () => {
  it('flags a one-night winter amber and names the rule it met', () => {
    expect(
      winterWords({
        state: 'set',
        from: day(9, 7),
        nights: 1,
        frozen: 11,
        reporting: 25,
        needs: 13,
      }),
    ).toEqual({
      value: 'One night',
      tone: 'warn',
      sub: '11 of 25 bodies ≤ 32 °F on 7 Oct · needs 13',
    });
    const set = winterWords({
      state: 'set',
      from: day(10, 20),
      nights: 3,
      frozen: 18,
      reporting: 25,
      needs: 13,
    });
    expect(set.value).toBe('Set in');
    expect(set.unit).toBe('Since 20 Nov');
    expect(set.tone).toBe('default');
    expect(winterWords({ state: 'not-yet' }).value).toBe('Not yet');
  });

  it('states the freezing line the bodies were counted under, never an assumed 32 °F', () => {
    const night = {
      state: 'set',
      from: day(10, 20),
      nights: 3,
      frozen: 18,
      reporting: 25,
    } as const;
    expect(winterWords({ ...night, needs: 13, freezeC: -2 }).sub).toBe(
      '18 of 25 bodies ≤ 28 °F on 20 Nov · needs 13',
    );
    expect(winterWords({ ...night, needs: 13, freezeC: 0 }).sub).toBe(
      '18 of 25 bodies ≤ 32 °F on 20 Nov · needs 13',
    );
  });
});

describe('imagery', () => {
  it('counts granules and says what landed', () => {
    expect(imageryWords({ state: 'running', granules: 0, cutterPinnedAt: day(9, 11) })).toEqual({
      value: 'Running',
      unit: '0 granules',
      tone: 'default',
      sub: 'Cutter pinned 11 Oct · nothing landed yet',
    });
    expect(imageryWords({ state: 'paused', granules: 1, lastLandedAt: day(11, 30) })).toMatchObject(
      { value: 'Paused', unit: '1 granule', tone: 'dim', sub: 'Last landed 30 Dec' },
    );
    expect(imageryWords({ state: 'not-started', granules: 0 }).value).toBe('Not started');
  });
});

describe('first skated', () => {
  it('shows last winter’s until this one has a skate', () => {
    expect(
      firstSkateWords({
        at: null,
        body: null,
        lastWinter: { at: day(11, 6, 2025), body: 'Crystal Lake' },
      }),
    ).toEqual({ value: '—', tone: 'dim', sub: 'Last winter 6 Dec · Crystal Lake' });
    expect(firstSkateWords({ at: day(11, 4), body: 'Post Pond' })).toEqual({
      value: '4 Dec',
      tone: 'default',
      sub: 'Post Pond',
    });
    expect(firstSkateWords({ at: null, body: null }).sub).toBe('');
  });
});

describe('an ended season', () => {
  it('reads Ended, with the date of its last frame, never running', () => {
    const words = imageryWords({ state: 'ended', granules: 412, lastFrameAt: day(3, 12, 2027) });
    expect(words).toEqual({
      value: 'Ended',
      unit: '412 granules',
      tone: 'dim',
      sub: 'Last frame 12 Apr',
    });
    expect(imageryWords({ state: 'ended', granules: 0, lastFrameAt: null }).sub).toBe(
      'No frame landed',
    );
  });
});

describe('seasonFromSummary — the server’s days and instants, in the reader’s zone', () => {
  const SUMMARY: HomeSummary = {
    season: 2026,
    countsFrom: '2026-10-01',
    watch: {
      opensOn: '2026-10-03',
      openedBy: ['sentinel'],
      closesOn: null,
      opening: { sentinels: [{ name: 'Upper Lake of the Clouds', lowC: -3 }] },
      sentinels: [],
    },
    winter: {
      state: 'set',
      from: '2026-11-05',
      nights: 2,
      frozen: 11,
      reporting: 25,
      needs: 13,
      freezeC: 0,
    },
    imagery: { state: 'running', granules: 4, lastLandedAt: 7, lastFrameAt: 6 },
    firstSkate: {
      first: { source: 'field', day: '2026-11-08', body: 'Crystal Lake' },
      lastWinter: { source: 'report', at: 99, body: 'Kezar Lake' },
    },
  };

  it('turns each record day into that calendar day, local, and keeps instants as they are', () => {
    const facts = seasonFromSummary(SUMMARY);
    expect(facts.watch).toMatchObject({ state: 'open', since: day(9, 3), sentinels: 1 });
    expect(facts.winter).toEqual({
      state: 'set',
      from: day(10, 5),
      nights: 2,
      frozen: 11,
      reporting: 25,
      needs: 13,
      freezeC: 0,
    });
    expect(facts.firstSkate).toEqual({
      at: day(10, 8),
      body: 'Crystal Lake',
      byStaff: true,
      lastWinter: { at: 99, body: 'Kezar Lake' },
    });
  });

  it('keeps the server’s nulls: a winter not recorded, a first skate the look could not find', () => {
    const facts = seasonFromSummary({ ...SUMMARY, watch: null, winter: null, firstSkate: null });
    expect(facts.watch).toEqual({ state: 'waiting', countsFrom: day(9, 1) });
    expect(facts.winter).toBeNull();
    expect(facts.firstSkate).toBeNull();
    expect(seasonFromSummary({ ...SUMMARY, winter: { state: 'not-yet' } }).winter).toEqual({
      state: 'not-yet',
    });
    expect(
      seasonFromSummary({ ...SUMMARY, firstSkate: { first: null, lastWinter: null } }).firstSkate,
    ).toEqual({ at: null, body: null, lastWinter: null });
  });

  it('a past season nothing recorded: watch, winter and imagery are not recorded, never a state', () => {
    const past = seasonFromSummary(
      {
        ...SUMMARY,
        season: 2025,
        watch: null,
        winter: { state: 'not-yet' },
        imagery: { state: 'not-started', granules: 0, lastLandedAt: null, lastFrameAt: null },
      },
      true,
    );
    expect(past.watch).toBeNull();
    expect(past.winter).toBeNull();
    expect(past.imagery).toBeNull();
    // A past season with a record keeps what it recorded.
    expect(seasonFromSummary({ ...SUMMARY, winter: { state: 'not-yet' } }, true).winter).toEqual({
      state: 'not-yet',
    });
  });
});

describe('a first skate staff recorded', () => {
  it('says so, so a staff date is never read as a report', () => {
    expect(firstSkateWords({ at: day(10, 8), body: 'Crystal Lake', byStaff: true })).toEqual({
      value: '8 Nov',
      tone: 'default',
      sub: 'Crystal Lake · recorded by staff',
    });
    expect(firstSkateWords({ at: day(10, 8), body: null, byStaff: true }).sub).toBe(
      'Recorded by staff',
    );
    expect(
      firstSkateWords({
        at: null,
        body: null,
        lastWinter: { at: day(11, 6, 2025), body: 'Low Plains', byStaff: true },
      }).sub,
    ).toBe('Last winter 6 Dec · Low Plains · recorded by staff');
  });

  it('names no place for a staff date entered without one — never a removed body', () => {
    const facts = seasonFromSummary({
      season: 2026,
      countsFrom: '2026-10-01',
      watch: null,
      winter: null,
      imagery: { state: 'not-started', granules: 0, lastLandedAt: null, lastFrameAt: null },
      firstSkate: { first: null, lastWinter: { source: 'field', day: '2025-12-20', body: null } },
    });
    expect(facts.firstSkate?.lastWinter).toEqual({
      at: day(11, 20, 2025),
      body: null,
      byStaff: true,
    });
    expect(firstSkateWords(facts.firstSkate as FirstSkate).sub).toBe(
      'Last winter 20 Dec · recorded by staff',
    );
  });
});
