import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  NOW,
  ROB,
  ROB_TREND,
  ROB_UNRECORDED,
  SARAH_STATS,
  SEASON,
  SEASON_EMPTY,
  SEASON_PENDING,
  SEASON_UNRECORDED,
  STATS_CAPPED,
  STATS_PENDING,
  STATS_UNRECORDED,
  TEAGAN_STATS,
} from './personFixtures';
import {
  agoWords,
  type Count,
  capitalize,
  contradictionsFact,
  countFact,
  countText,
  dateWords,
  dayKeyWords,
  decisionsFact,
  type Fact,
  firstName,
  momentWords,
  monthKeyWords,
  NOT_RECORDED,
  openFlagsFact,
  overturnedFact,
  PENDING_WORDS,
  personName,
  reportsFact,
  staffSinceFact,
  statusNoteWords,
  timeLeftWords,
  timeToDecideFact,
  trendBars,
  trendLabel,
  trustPointsFact,
  utcDayWords,
  weekBars,
  weeksTotal,
} from './personModel';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const local = (m: number, d: number, h = 12, min = 0, y = 2026) =>
  new Date(y, m - 1, d, h, min).getTime();

/** No labeled value is blank, a bare zero standing for an answer, or "undefined". */
function assertSaid(f: Fact) {
  expect(f.value.trim()).not.toBe('');
  expect(f.value).not.toContain('undefined');
  expect(f.value).not.toContain('NaN');
  expect(f.sub ?? '').not.toContain('undefined');
  if (f.state === 'pending' || f.state === 'unrecorded' || f.state === 'empty') {
    expect(f.value).not.toMatch(/\d/);
    expect(f.sub).toBeTruthy();
  }
  if (f.state === 'pending') expect(f.sub).toContain(PENDING_WORDS);
  if (f.state === 'pending') expect(f.value).not.toContain('+');
}

const countArb = fc.record({ count: fc.nat({ max: 5000 }), capped: fc.boolean() });

describe('the three answers', () => {
  it('a count, a floor, pending and not recorded are never confused (property)', () => {
    fc.assert(
      fc.property(fc.option(countArb, { nil: null }), fc.boolean(), (count, pending) => {
        const f = countFact(count, { pending });
        assertSaid(f);
        if (pending) {
          expect(f.state).toBe('pending');
          expect(f.sub).toBe(PENDING_WORDS);
        } else if (count === null) {
          expect(f.state).toBe('unrecorded');
          expect(f.sub).toBe(NOT_RECORDED);
        } else if (count.capped) {
          expect(f.state).toBe('capped');
          expect(f.value.endsWith('+')).toBe(true);
        } else {
          expect(f.value).toBe(count.count.toLocaleString('en-US'));
        }
      }),
    );
  });

  it('countText writes a floor with "+"', () => {
    expect(countText({ count: 1204, capped: false })).toBe('1,204');
    expect(countText({ count: 200, capped: true })).toBe('200+');
  });

  it('keeps a unit, a sub-line and a tone', () => {
    expect(
      countFact({ count: 3, capped: false }, { unit: 'this week', sub: 'S', tone: 'warn' }),
    ).toEqual({
      value: '3',
      unit: 'this week',
      sub: 'S',
      tone: 'warn',
      state: 'value',
    });
  });

  it('every strip fact says something for any read (property)', () => {
    const stats = fc.record({
      decisions: fc.record({ thisWeek: countArb, undoneByOthers: countArb }),
      timeToDecide: fc.record({
        medianMs: fc.option(fc.nat({ max: 30 * DAY }), { nil: null }),
        decided: fc.nat({ max: 50 }),
        capped: fc.boolean(),
      }),
      staffSince: fc.option(
        fc.record({
          at: fc.integer({ min: local(1, 1, 12, 0, 2020), max: NOW }),
          role: fc.constant('moderator' as const),
        }),
        { nil: null },
      ),
      roleSince: fc.option(
        fc.record({
          at: fc.integer({ min: local(1, 1, 12, 0, 2020), max: NOW }),
          role: fc.constant('admin' as const),
        }),
        { nil: null },
      ),
      tenureCapped: fc.boolean(),
      pending: fc.constantFrom([] as const, ['undoChains'] as const),
      weeks: fc.array(
        fc.record({ from: fc.constant(0), count: fc.nat({ max: 99 }), capped: fc.boolean() }),
        { minLength: 9, maxLength: 9 },
      ),
    });
    fc.assert(
      fc.property(stats, (s) => {
        const read = s as unknown as typeof SARAH_STATS;
        for (const f of [
          decisionsFact(read),
          timeToDecideFact(read),
          staffSinceFact(read, 'admin', NOW),
        ]) {
          assertSaid(f);
        }
        expect(weeksTotal(read)).not.toContain('undefined');
      }),
    );
    const season = fc.record({
      season: fc.constant(2026),
      opensOn: fc.constant('2026-10-01'),
      empty: fc.boolean(),
      overturned: fc.option(countArb, { nil: null }),
      pending: fc.constantFrom([] as const, ['undoChains'] as const),
    });
    fc.assert(
      fc.property(season, (s) => assertSaid(overturnedFact(s as unknown as typeof SEASON))),
    );
    fc.assert(
      fc.property(fc.option(fc.nat({ max: 99 }), { nil: null }), (c) =>
        assertSaid(contradictionsFact(c)),
      ),
    );
    fc.assert(
      fc.property(countArb, countArb, fc.boolean(), (onUser, onContent, pending) =>
        assertSaid(openFlagsFact({ onUser, onContent }, pending)),
      ),
    );
  });
});

describe('words', () => {
  it('writes dates, moments and month keys', () => {
    expect(dateWords(local(10, 3), NOW)).toBe('3 Oct');
    expect(dateWords(local(10, 3, 12, 0, 2025), NOW)).toBe('3 Oct 2025');
    expect(momentWords(local(10, 10, 19, 48), NOW)).toBe('Sat 10 Oct 19:48');
    expect(dayKeyWords('2026-10-01')).toBe('1 Oct');
    expect(monthKeyWords('2026-02')).toBe('Feb 2026');
    expect(utcDayWords(Date.UTC(2026, 7, 17))).toBe('17 Aug');
  });

  it('writes the time left out, never abbreviated', () => {
    expect(timeLeftWords(NOW + 31 * HOUR, NOW)).toBe('1 day left');
    expect(timeLeftWords(NOW + 4 * DAY + HOUR, NOW)).toBe('4 days left');
    expect(timeLeftWords(NOW + 5 * HOUR, NOW)).toBe('5 hours left');
    expect(timeLeftWords(NOW + HOUR, NOW)).toBe('1 hour left');
    expect(timeLeftWords(NOW + 10 * 60_000, NOW)).toBe('Less than an hour left');
  });

  it('writes ages with "ago"', () => {
    expect(agoWords(NOW - 2 * DAY, NOW)).toBe('2 days ago');
    expect(agoWords(NOW - 5 * HOUR, NOW)).toBe('5 hours ago');
    expect(agoWords(NOW - 3 * 60_000, NOW)).toBe('3 minutes ago');
    expect(agoWords(NOW + 1000, NOW)).toBe('Just now');
  });

  it('names a person by their name, then their handle, else not at all', () => {
    expect(personName({ displayName: 'Sarah Berman', username: 'sarah' })).toBe('Sarah Berman');
    expect(personName({ displayName: '  ', username: 'sarah' })).toBe('sarah');
    expect(personName({ displayName: null, username: null })).toBeNull();
    expect(firstName('Sarah Berman')).toBe('Sarah');
    expect(capitalize('')).toBe('');
    expect(capitalize('on')).toBe('On');
  });
});

describe('the status note', () => {
  it('says who suspended, when, why, and when it lifts — on its own line', () => {
    const note = ROB.statusNote;
    if (note === null) throw new Error('fixture');
    expect(statusNoteWords(note, NOW)).toEqual({
      badge: 'Suspended · 1 day left',
      tone: 'warn',
      reason: 'Second unsafe report in a week; cooling off',
      by: { name: 'Matt', via: null },
      when: 'Suspended Sat 10 Oct 19:48',
      lifts: 'Lifts on its own Thu 15 Oct 19:48',
    });
  });

  it('says not recorded where the read has no fact', () => {
    const note = ROB_UNRECORDED.statusNote;
    if (note === null) throw new Error('fixture');
    const w = statusNoteWords(note, NOW);
    expect(w.reason).toBeNull();
    expect(w.by).toBeNull();
    expect(w.when).toBeNull();
  });

  it('a ban, a lapsed suspension, an open-ended one, a script, the system', () => {
    const base = {
      at: NOW,
      by: null,
      via: null,
      reason: '  ',
      suspendedUntil: null,
      lapsed: false,
    };
    expect(statusNoteWords({ ...base, action: 'ban' }, NOW)).toMatchObject({
      badge: 'Banned',
      tone: 'bad',
      reason: null,
      by: 'system',
      when: 'Banned Wed 14 Oct 12:00',
      lifts: null,
    });
    expect(statusNoteWords({ ...base, action: 'suspend' }, NOW).badge).toBe(
      'Suspended · until lifted',
    );
    const lapsed = statusNoteWords(
      { ...base, action: 'suspend', suspendedUntil: NOW - HOUR, lapsed: true },
      NOW,
    );
    expect(lapsed.badge).toBe('Suspended · ran its course');
    expect(lapsed.lifts).toBe('Ran its course Wed 14 Oct 11:00 · lifting on its own');
    // The read said not yet (the minute the page opened); the live clock has passed the end since.
    const passed = statusNoteWords(
      { ...base, action: 'suspend', suspendedUntil: NOW - HOUR, lapsed: false },
      NOW,
    );
    expect(passed.badge).toBe('Suspended · ran its course');
    expect(passed.lifts).toBe('Ran its course Wed 14 Oct 11:00 · lifting on its own');
    const scripted = statusNoteWords(
      {
        ...base,
        action: 'ban',
        by: {
          userId: 'x' as never,
          displayName: 'Teagan Atwater',
          username: 't',
          profileImageUrl: null,
        },
        via: 'seed-x',
      },
      NOW,
    );
    expect(scripted.by).toEqual({ name: 'Teagan', via: 'seed-x' });
    const rowless = statusNoteWords(
      {
        ...base,
        action: 'ban',
        by: { userId: 'x' as never, displayName: null, username: null, profileImageUrl: null },
      },
      NOW,
    );
    expect(rowless.by).toEqual({ name: 'Name still being prepared', via: null });
  });
});

describe('the skater strip', () => {
  it('contradictions turn amber at the flag threshold', () => {
    expect(contradictionsFact(3)).toMatchObject({ value: '3', tone: 'warn' });
    expect(contradictionsFact(2)).toMatchObject({ value: '2', tone: 'default' });
    expect(contradictionsFact(null)).toMatchObject({ value: '—', sub: NOT_RECORDED });
  });

  it('open flags: on content, on the person under it; pending while the subjects backfill', () => {
    expect(openFlagsFact(ROB.strip.openFlags, false)).toMatchObject({
      value: '1',
      unit: 'on content',
      tone: 'bad',
      sub: '0 on the person',
    });
    const none = { onUser: { count: 0, capped: false }, onContent: { count: 0, capped: false } };
    expect(openFlagsFact(none, false).tone).toBe('default');
    expect(openFlagsFact(ROB.strip.openFlags, true)).toMatchObject({
      state: 'pending',
      sub: `${PENDING_WORDS} · 0 on the person`,
    });
  });

  it('reports, trust points and the trend', () => {
    expect(reportsFact(ROB_TREND)).toMatchObject({ value: '14', sub: '2 hidden · 1 edited' });
    expect(trustPointsFact(41)).toMatchObject({ value: '41', sub: 'Raw score' });
    expect(trendLabel(ROB_TREND)).toBe('Reports · 9 months');
    expect(trendLabel({ ...ROB_TREND, months: ROB_TREND.months.slice(-1) })).toBe(
      'Reports · 1 month',
    );
    const bars = trendBars(ROB_TREND);
    expect(bars).toHaveLength(9);
    expect(bars[8]).toEqual({ key: '2026-10', title: 'Oct 2026', kept: 3, hidden: 1 });
  });
});

describe('the staff strip', () => {
  it('decisions this week and how many others undid', () => {
    expect(decisionsFact(SARAH_STATS)).toMatchObject({
      value: '18',
      unit: 'this week',
      sub: '2 later undone by others',
    });
    expect(decisionsFact(TEAGAN_STATS).sub).toBe('1 later undone by someone else');
    expect(
      decisionsFact({
        ...SARAH_STATS,
        decisions: { ...SARAH_STATS.decisions, undoneByOthers: { count: 0, capped: false } },
      }).sub,
    ).toBe('None undone by others');
    expect(decisionsFact(STATS_PENDING).sub).toBe('Undone by others · still being prepared');
    expect(decisionsFact(STATS_CAPPED)).toMatchObject({ value: '2,000+', state: 'capped' });
  });

  it('time to decide in minutes, hours or days; capped and unrecorded said', () => {
    expect(timeToDecideFact(SARAH_STATS)).toMatchObject({ value: '41', unit: 'min' });
    const at = (ms: number) =>
      timeToDecideFact({
        ...SARAH_STATS,
        timeToDecide: { medianMs: ms, decided: 3, capped: false },
      });
    expect(at(3 * HOUR)).toMatchObject({ value: '3', unit: 'hours' });
    expect(at(3 * DAY)).toMatchObject({ value: '3', unit: 'days' });
    expect(timeToDecideFact(STATS_CAPPED)).toMatchObject({ state: 'capped', value: '—' });
    expect(timeToDecideFact(STATS_UNRECORDED)).toMatchObject({
      state: 'unrecorded',
      sub: 'No filed items decided this week',
    });
    expect(
      timeToDecideFact({
        ...SARAH_STATS,
        timeToDecide: { medianMs: null, decided: 4, capped: false },
      }).sub,
    ).toBe(NOT_RECORDED);
  });

  it('overturned this season, the empty season and its opening day', () => {
    expect(overturnedFact(SEASON)).toMatchObject({ value: '1', sub: 'This season' });
    expect(overturnedFact(SEASON_EMPTY)).toMatchObject({
      state: 'empty',
      sub: 'Record begins 1 Oct',
    });
    expect(overturnedFact(SEASON_PENDING).state).toBe('pending');
    expect(overturnedFact(SEASON_UNRECORDED).state).toBe('unrecorded');
  });

  it('staff since, with the role held and since when', () => {
    expect(staffSinceFact(SARAH_STATS, 'admin', NOW)).toMatchObject({
      value: '12 Jan',
      sub: 'Admin since 3 Mar',
    });
    expect(staffSinceFact(TEAGAN_STATS, 'admin', NOW)).toMatchObject({
      value: '2 Jan',
      sub: 'Admin from the start',
    });
    expect(staffSinceFact({ ...SARAH_STATS, roleSince: null }, 'admin', NOW).sub).toBe(
      'Admin · since not recorded yet',
    );
    expect(staffSinceFact(STATS_PENDING, 'admin', NOW).state).toBe('pending');
    expect(staffSinceFact(STATS_CAPPED, 'admin', NOW).state).toBe('capped');
    expect(staffSinceFact(STATS_UNRECORDED, 'admin', NOW).state).toBe('unrecorded');
  });

  it('nine weeks, the last running to today', () => {
    const bars = weekBars(SARAH_STATS, Date.UTC(2026, 9, 14, 12));
    expect(bars).toHaveLength(9);
    expect(bars[0]?.title).toBe('13–19 Aug');
    expect(bars[8]).toMatchObject({ title: '8–14 Oct', count: 18 });
    expect(bars[7]?.title).toBe('1–7 Oct');
    expect(bars[6]?.title).toBe('24–30 Sep');
    const across = weekBars(
      { ...SARAH_STATS, weeks: [{ from: Date.UTC(2026, 8, 28), count: 1, capped: false }] },
      NOW + 9 * DAY,
    );
    expect(across[0]?.title).toBe('28 Sep–4 Oct');
    expect(weeksTotal(SARAH_STATS)).toBe('90 in all');
    expect(weeksTotal(STATS_CAPPED)).toBe('90+ in all');
    const one = weekBars(
      { ...SARAH_STATS, weeks: [{ from: Date.UTC(2026, 9, 14), count: 1, capped: false }] },
      Date.UTC(2026, 9, 14, 6),
    );
    expect(one[0]?.title).toBe('14 Oct');
  });
});

describe('a count is a count', () => {
  it('is typed as the server sends it', () => {
    const c: Count = { count: 1, capped: false };
    expect(countFact(c).value).toBe('1');
  });
});
