import { PEOPLE_LANES } from '@skating/core';
import { describe, expect, it } from 'vitest';

import {
  KATE,
  LANES,
  LANES_CAPPED,
  LANES_FLAGS_PREPARING,
  LANES_PREPARING,
  MATT,
  NOW,
  PAT,
  personRow,
  ROB,
  SARAH,
} from './peopleFixtures';
import { lanesFor, PEOPLE_LANE_INFO } from './peopleLanes';
import {
  endWords,
  flagWords,
  kickerText,
  laneCount,
  lanesPendingNote,
  listShort,
  membershipPending,
  pendingWords,
  reasonWords,
  rowAge,
  rowChips,
  rowView,
  STILL_PREPARING,
  weekdayDate,
} from './peopleModel';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const entry = (read: typeof LANES, lane: string) => read.lanes.find((l) => l.lane === lane);
const NO_FACTS = { flagsPending: false, flagsFloor: false, appealsFloor: false };

describe('the lanes', () => {
  it('words every lane the server serves, in its order, with core’s names', () => {
    expect(Object.keys(PEOPLE_LANE_INFO)).toEqual([...PEOPLE_LANES]);
    expect(PEOPLE_LANE_INFO.leaving.label).toBe('Leaving · 30-day window');
    expect(PEOPLE_LANE_INFO.deleted.label).toBe('Deleted · tombstones');
  });

  it('gives Appeals open only to a viewer who reads support', () => {
    expect(lanesFor(true)).toContain('appeals');
    expect(lanesFor(false)).not.toContain('appeals');
    expect(lanesFor(false)).toHaveLength(PEOPLE_LANES.length - 1);
  });
});

describe('the counts: not ready, a floor, a number', () => {
  it('draws no count for a lane still being prepared — never a number, never a “+”', () => {
    expect(laneCount(entry(LANES_PREPARING, 'everyone'))).toBeNull();
    expect(laneCount(undefined)).toBeNull();
    expect(laneCount(entry(LANES, 'everyone'))).toEqual({ count: 38, capped: false });
    expect(laneCount(entry(LANES_CAPPED, 'flagged'))).toEqual({ count: 200, capped: true });
  });

  it('says which counts are still being prepared at the lanes’ foot, or none once all are in', () => {
    expect(lanesPendingNote(LANES_PREPARING.lanes)).toBe('Counts still being prepared');
    expect(lanesPendingNote(LANES_FLAGS_PREPARING.lanes)).toBe(
      'Flagged count still being prepared',
    );
    const two = LANES.lanes.map((l) =>
      l.lane === 'flagged' || l.lane === 'staff' ? { ...l, pending: ['rows' as const] } : l,
    );
    expect(lanesPendingNote(two)).toBe('Staff and Flagged counts still being prepared');
    expect(lanesPendingNote(LANES.lanes)).toBeNull();
  });

  it('heads the list with its count and order, and never a number while it isn’t ready', () => {
    expect(kickerText('suspended', entry(LANES, 'suspended'), false)).toBe('1 · by end date');
    expect(kickerText('staff', entry(LANES, 'staff'), false)).toBe('3 · admins first');
    expect(kickerText('flagged', entry(LANES_CAPPED, 'flagged'), false)).toBe(
      '200+ · oldest first',
    );
    // Not ready: no number and no "+" — only the order; the note over the rows says the rest.
    expect(kickerText('everyone', entry(LANES_PREPARING, 'everyone'), false)).toBe('by name');
    expect(kickerText('everyone', undefined, false)).toBe('by name');
    expect(kickerText('everyone', entry(LANES, 'everyone'), true)).toBe('best match first');
  });
});

describe('how a list ends', () => {
  it('ends “All N” only when it is the whole lane', () => {
    expect(endWords('everyone', [], [], 3)).toBeNull();
    expect(endWords('staff', ['flags_capped'], [], 3)).toBeNull();
    expect(endWords(null, ['rows_missing'], [], 3)).toBeNull();
  });

  it('says still being prepared while who is in it may be wrong', () => {
    expect(endWords('everyone', [], ['rows'], 3)).toBe(STILL_PREPARING);
    expect(endWords('flagged', [], ['flagSubjects'], 0)).toBe(STILL_PREPARING);
    expect(endWords('staff', [], ['flagSubjects'], 2)).toBeNull();
  });

  it('counts what is shown when the list is short of its lane', () => {
    expect(listShort('flagged', ['flags_capped'])).toBe(true);
    expect(listShort('appeals', ['tickets_capped'])).toBe(true);
    expect(listShort('appeals', ['flags_capped'])).toBe(false);
    expect(endWords('flagged', ['flags_capped'], [], 200)).toBe('200 shown');
    expect(endWords('appeals', ['rows_missing'], [], 0)).toBe('None shown');
  });
});

describe('why a list may be short', () => {
  it('words every reason the server gives', () => {
    for (const r of ['rows_missing', 'flags_capped', 'tickets_capped', 'count_capped'] as const) {
      expect(reasonWords(r)).toMatch(/^[A-Z]/);
    }
    expect(reasonWords('count_capped')).toContain('the list goes on');
  });

  it('says a list may be missing people while the rows (or, on Flagged, the subjects) aren’t ready', () => {
    expect(membershipPending('everyone', ['rows'])).toBe(true);
    expect(membershipPending('everyone', ['flagSubjects'])).toBe(false);
    expect(membershipPending('flagged', ['flagSubjects'])).toBe(true);
    expect(membershipPending(null, ['rows'])).toBe(true);
    expect(pendingWords('everyone', ['rows'])).toBe(
      'Still being prepared: this list may not have everyone yet',
    );
    expect(pendingWords('staff', ['flagSubjects'])).toBe('Open flags are still being prepared');
    expect(pendingWords('staff', [])).toBeNull();
  });
});

describe('a row', () => {
  it('draws board 8.1’s row: the amber chip first, the date, the flag, the appeal, the reason', () => {
    const view = rowView(ROB, 'suspended', NO_FACTS, NOW);
    expect(view.chips).toEqual([
      { label: 'Suspended', tone: 'warn' },
      { label: 'Trusted', tone: 'default' },
    ]);
    expect(view.sub).toBe('Until Thu 15 Oct · Restricted: comments · 1 open flag · 1 appeal');
    expect(view.reason).toBe('Reason: “Second unsafe report in a week; cooling off”');
    expect(view.age).toBe('3 d');
    expect(view.name).toBe('Rob Tremblay');
    expect(view.handle).toBe('rtremblay');
  });

  it('reads a suspension whose end has passed as run its course, never a date still ahead', () => {
    const until = ROB.suspension?.until as number;
    expect(rowView(ROB, 'suspended', NO_FACTS, until - 60_000).sub).toMatch(/^Until Thu 15 Oct/);
    for (const now of [until, until + 60_000, until + 3 * DAY]) {
      const sub = rowView(ROB, 'suspended', NO_FACTS, now).sub ?? '';
      expect(sub).toMatch(/^Ran its course Thu 15 Oct · lifting on its own/);
      expect(sub).not.toContain('Until');
    }
  });

  describe('the server follow-up’s row facts, present or absent', () => {
    const at = (m: number, d: number, h = 12, min = 0) =>
      new Date(2026, m - 1, d, h, min).getTime();
    const sarah = {
      ...SARAH,
      staff: {
        lastSeenInConsoleAt: NOW - 2 * 60_000,
        roleSince: at(3, 3),
        decisionsThisWeek: { count: 18, capped: false },
      },
    };

    it('draws board 8.2’s staff row when the server gives it', () => {
      expect(rowView(sarah, 'staff', NO_FACTS, NOW)).toMatchObject({
        sub: 'Admin since 3 Mar · 18 decisions this week · 1 open flag',
        age: '2 min',
      });
    });

    it('takes a plain number, a floor, one, or nothing for the week’s decisions', () => {
      const sub = (decisionsThisWeek: unknown) =>
        rowView(
          { ...sarah, staff: { ...sarah.staff, decisionsThisWeek } } as typeof sarah,
          'staff',
          NO_FACTS,
          NOW,
        ).sub;
      expect(sub(7)).toContain('7 decisions this week');
      expect(sub({ count: 200, capped: true })).toContain('200+ decisions this week');
      expect(sub(1)).toContain('1 decision this week');
      expect(sub(null)).toBe('Admin since 3 Mar · 1 open flag');
    });

    it('falls back to today’s row without them: the role alone, no age', () => {
      expect(rowView(SARAH, 'staff', NO_FACTS, NOW)).toMatchObject({
        sub: 'Admin · 1 open flag',
        age: null,
      });
      const unseen = { ...sarah, staff: { lastSeenInConsoleAt: null, roleSince: null } };
      expect(rowView(unseen, 'staff', NO_FACTS, NOW)).toMatchObject({
        sub: 'Admin · 1 open flag',
        age: null,
      });
    });

    it('ages Flagged and Appeals open from the oldest open item, else (today’s server) from joining', () => {
      const flagged = { ...ROB, oldestOpenAt: NOW - 5 * HOUR };
      expect(rowView(flagged, 'flagged', NO_FACTS, NOW).age).toBe('5 h');
      expect(rowView(flagged, 'appeals', NO_FACTS, NOW).age).toBe('5 h');
      expect(rowView(ROB, 'appeals', NO_FACTS, NOW).age).toBe(
        rowView(ROB, 'everyone', NO_FACTS, NOW).age,
      );
    });

    it('draws no age for an oldest open item the follow-up has no time for — never the join age', () => {
      expect(rowView({ ...ROB, oldestOpenAt: null }, 'flagged', NO_FACTS, NOW).age).toBeNull();
      expect(rowView({ ...ROB, oldestOpenAt: null }, 'appeals', NO_FACTS, NOW).age).toBeNull();
    });

    it('names an account with no name on it by its handle, as the person page does', () => {
      expect(rowView({ ...ROB, displayName: '  ' }, 'everyone', NO_FACTS, NOW).name).toBe(
        'rtremblay',
      );
    });
  });

  it('names staff by role, and gives a staffer no age: no read says when they were last here', () => {
    expect(rowView(MATT, 'staff', NO_FACTS, NOW)).toMatchObject({
      sub: 'Moderator',
      age: null,
      chips: [],
    });
    expect(rowView(SARAH, 'staff', NO_FACTS, NOW).sub).toBe('Admin · 1 open flag');
  });

  it('says where the flags are on Flagged, and draws none while they may be wrong', () => {
    const both = { onUser: 1, onContent: 2 };
    expect(flagWords(both, true, NO_FACTS)).toBe('3 open flags: 1 on them, 2 on their content');
    expect(flagWords({ onUser: 2, onContent: 0 }, true, NO_FACTS)).toBe('2 open flags on them');
    expect(flagWords({ onUser: 0, onContent: 1 }, true, NO_FACTS)).toBe(
      '1 open flag on their content',
    );
    expect(flagWords(both, false, { flagsPending: false, flagsFloor: true })).toBe('3+ open flags');
    // A floor of one may be more than one: plural, as every floor on the People pages is.
    expect(
      flagWords({ onUser: 0, onContent: 1 }, true, { flagsPending: false, flagsFloor: true }),
    ).toBe('1+ open flags on their content');
    expect(flagWords(both, false, { flagsPending: true, flagsFloor: false })).toBeNull();
    expect(flagWords({ onUser: 0, onContent: 0 }, false, NO_FACTS)).toBeNull();
  });

  it('marks appeals a floor when the ticket queue was capped, and draws none for a moderator', () => {
    expect(rowView(ROB, 'appeals', { ...NO_FACTS, appealsFloor: true }, NOW).sub).toContain(
      '1+ appeals',
    );
    expect(rowView(ROB, 'appeals', NO_FACTS, NOW).sub).toMatch(/1 appeal$/);
    const moderatorView = rowView({ ...ROB, appeals: null }, 'suspended', NO_FACTS, NOW);
    expect(moderatorView.sub).not.toContain('appeal');
  });

  it('chips a ban red, a deletion and a departure dim, and an open-ended suspension “until lifted”', () => {
    expect(rowChips(personRow('a', 'A', 'a', { status: 'banned' }))).toEqual([
      { label: 'Banned', tone: 'bad' },
    ]);
    expect(rowChips(personRow('a', 'A', 'a', { status: 'deleted' }))[0]?.label).toBe('Deleted');
    expect(rowChips(personRow('a', 'A', 'a', { leavingUntil: NOW + DAY }))[0]?.label).toBe(
      'Leaving',
    );
    const open = personRow('a', 'A', 'a', { suspension: { until: null } });
    expect(rowView(open, 'suspended', NO_FACTS, NOW).sub).toBe('Until lifted');
  });

  it('quotes a reason only for a suspension or a ban in force', () => {
    const lapsed = { ...ROB, suspension: null, status: 'active' as const };
    expect(rowView(lapsed, 'everyone', NO_FACTS, NOW).reason).toBeNull();
    const banned = personRow('a', 'A', 'a', { status: 'banned', statusReason: '  Spam  ' });
    expect(rowView(banned, 'banned', NO_FACTS, NOW).reason).toBe('Reason: “Spam”');
    expect(rowView({ ...banned, statusReason: ' ' }, 'banned', NO_FACTS, NOW).reason).toBeNull();
  });

  it('names an account with no name by its handle — never blank', () => {
    expect(rowView(personRow('a', '  ', 'quiet'), 'everyone', NO_FACTS, NOW).name).toBe('quiet');
  });

  it('says when an account goes, or went', () => {
    const leaving = personRow('a', 'A', 'a', { leavingUntil: NOW + 12 * DAY });
    expect(rowView(leaving, 'leaving', NO_FACTS, NOW)).toMatchObject({
      sub: 'Deletion completes Mon 26 Oct',
      age: '12 d left',
    });
    const gone = personRow('a', 'A', 'a', {
      status: 'deleted',
      deletedAt: NOW - 2 * DAY,
      statusSince: NOW - 2 * DAY,
    });
    expect(rowView(gone, 'deleted', NO_FACTS, NOW)).toMatchObject({
      sub: 'Deleted Mon 12 Oct',
      age: '2 d',
    });
  });

  it('counts each lane’s age from its own fact, and draws none where nothing is on record', () => {
    expect(rowAge(PAT, 'restricted', NOW)).toBe('3 d');
    expect(rowAge(KATE, 'joined', NOW)).toBe('2 d');
    expect(rowAge(personRow('a', 'A', 'a'), 'status', NOW)).toBeNull();
    expect(rowAge(personRow('a', 'A', 'a'), 'restricted', NOW)).toBeNull();
    expect(rowAge(personRow('a', 'A', 'a'), 'leaving', NOW)).toBeNull();
    expect(rowAge(KATE, 'seen', NOW)).toBeNull();
    // A search ages a row from when the account was made.
    expect(rowView(KATE, null, NO_FACTS, NOW).age).toBe('2 d');
  });
});

describe('words', () => {
  it('writes a row’s age in the board’s short form, never units written out', () => {
    // Every lane's age, through the console's one list-row age.
    const ages = PEOPLE_LANES.flatMap((lane) =>
      [ROB, KATE, PAT, personRow('a', 'A', 'a', { leavingUntil: NOW + 30 * HOUR })].map(
        (r) => rowView(r, lane, NO_FACTS, NOW).age,
      ),
    );
    for (const age of ages.filter((a): a is string => a !== null)) {
      expect(age).toMatch(/^(\d+(\.\d)? (min|h|d)( left)?|Ends now)$/);
    }
  });

  it('says how long is left in the short form, and when the window has run out', () => {
    const leaving = (ms: number) =>
      rowAge(personRow('a', 'A', 'a', { leavingUntil: NOW + ms }), 'leaving', NOW);
    expect(leaving(DAY + HOUR)).toBe('1 d left');
    expect(leaving(5 * HOUR)).toBe('5 h left');
    expect(leaving(10 * 60_000)).toBe('10 min left');
    expect(leaving(0)).toBe('Ends now');
    expect(leaving(-HOUR)).toBe('Ends now');
  });

  it('writes a day as the board does', () => {
    expect(weekdayDate(new Date(2026, 9, 15, 19, 48).getTime())).toBe('Thu 15 Oct');
  });
});
