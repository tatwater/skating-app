import { describe, expect, it } from 'vitest';

import {
  firstSkateWords,
  iceWatchFromRecord,
  iceWatchWords,
  imageryWords,
  isoDay,
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
