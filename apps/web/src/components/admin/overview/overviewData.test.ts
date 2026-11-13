import { describe, expect, it } from 'vitest';

import {
  type ActionRow,
  actionWords,
  type ConsoleOverview,
  corpusFromReviewCounts,
  dollars,
  feedFromActions,
  inboxFootAges,
  inboxFromOverview,
  inboxTotal,
  machineryTrouble,
  peopleFromOverview,
  suspensionDetail,
  verbWords,
} from './overviewData';
import { HOME, MACHINERY } from './overviewFixtures';
import { dayMonth } from './overviewModel';

const c = (count: number, capped = false) => ({ count, capped });

const OVERVIEW: ConsoleOverview = {
  inbox: {
    safety: c(1),
    accessReports: c(3),
    requests: c(6),
    placesAsked: c(4),
    drawnBodies: c(1),
    contentFlags: c(2),
    support: null,
    oldestOpenAt: 1_000,
  },
  people: {
    moderators: c(1),
    admins: c(2),
    newThisWeek: c(2),
    suspended: c(1),
    nextSuspensionEnds: 5_000,
    banned: c(0),
    flaggedPeople: c(1),
    appealsOpen: null,
    leaving: c(0),
  },
};

describe('the Inbox card', () => {
  it('takes every lane from the server, a hidden lane as null', () => {
    const inbox = inboxFromOverview(OVERVIEW.inbox);
    expect(inbox.lanes.support).toBeNull();
    expect(inbox.lanes.safety).toEqual(c(1));
    expect(inbox.oldestOpenAt).toBe(1_000);
    expect(inboxTotal(inbox)).toEqual(c(17));
  });

  it('ages the oldest item from now, never below zero', () => {
    const inbox = inboxFromOverview(OVERVIEW.inbox);
    expect(inboxFootAges(inbox, 4_000)).toEqual({ oldestMs: 3_000, medianMs: null });
    expect(inboxFootAges(inbox, 0)).toEqual({ oldestMs: 0, medianMs: null });
    expect(inboxFootAges({ ...inbox, oldestOpenAt: null }, 4_000)).toBeNull();
    expect(inboxFootAges({ ...inbox, medianAgeMs: 7 }, 4_000)?.medianMs).toBe(7);
  });
});

describe('the Corpus card', () => {
  it('folds the intake reasons into the Corpus tasks', () => {
    const corpus = corpusFromReviewCounts({
      'duplicate-candidate': { count: 200, capped: false, advisory: false },
      'same-source-duplicate': { count: 83, capped: false, advisory: false },
      'name-conflict': { count: 412, capped: false, advisory: true },
      'class-conflict': { count: 100, capped: false, advisory: false },
      'class-dissent': { count: 40, capped: true, advisory: false },
      'bay-without-parent': { count: 61, capped: false, advisory: false },
    });
    expect(corpus.duplicates).toEqual(c(283));
    expect(corpus.nameConflicts).toEqual(c(412));
    expect(corpus.classConflicts).toEqual(c(140, true));
    expect(corpus.orphanBays).toEqual(c(61));
    // What no read carries yet stays out until the route passes it.
    expect(corpus.chordRefits).toBeNull();
    expect(corpus.preIcePass).toBeNull();
  });

  it('counts a reason the server left out as zero, and takes the extras it is given', () => {
    const corpus = corpusFromReviewCounts({}, { chordRefits: c(2), campaignAt: 9 });
    expect(corpus.duplicates).toEqual(c(0));
    expect(corpus.chordRefits).toEqual(c(2));
    expect(corpus.campaignAt).toBe(9);
  });
});

describe('the People card', () => {
  it('passes the server’s counts through with the total when one is read', () => {
    expect(peopleFromOverview(OVERVIEW.people).totalUsers).toBeNull();
    expect(peopleFromOverview(OVERVIEW.people, c(38)).totalUsers).toEqual(c(38));
  });

  it('names one suspension’s end, or the soonest of several', () => {
    const at = new Date(2027, 0, 19).getTime();
    expect(suspensionDetail(c(1), at, dayMonth)).toBe('until 19 Jan');
    expect(suspensionDetail(c(3), at, dayMonth)).toBe('next ends 19 Jan');
    expect(suspensionDetail(c(1, true), at, dayMonth)).toBe('next ends 19 Jan');
    expect(suspensionDetail(c(0), at, dayMonth)).toBeNull();
    expect(suspensionDetail(c(2), null, dayMonth)).toBeNull();
  });
});

describe('machinery and cost', () => {
  it('counts the stalled and failed runs for the heads row', () => {
    expect(machineryTrouble(MACHINERY)).toEqual({ stalled: 1, failed: 2 });
  });

  it('writes dollars to the cent', () => {
    expect(dollars(0)).toBe('$0.00');
    expect(dollars(48.9)).toBe('$48.90');
    expect(dollars(1234.5)).toBe('$1,234.50');
    expect(HOME.cost?.months).toHaveLength(4);
  });
});

describe('the audit feed', () => {
  const row = (over: Partial<ActionRow>): ActionRow =>
    ({
      id: 'a',
      action: 'decline_request',
      targetType: 'waterBodyRequest',
      targetId: 'r1',
      reason: '',
      createdAt: 10,
      actor: { userId: 'u', username: 'sarah', displayName: 'Sarah Berman' },
      undo: { kind: 'none' },
      ...over,
    }) as unknown as ActionRow;

  it('names staff by first name, the machine as null, an author in full', () => {
    const [staff, machine, author] = feedFromActions([
      row({}),
      row({ id: 'b', actor: null, action: 'activate_body', targetType: 'waterbody' }),
      row({
        id: 'c',
        action: 'author_delete',
        targetType: 'report',
        actor: { userId: 'r', username: 'rtremblay', displayName: 'Rob Tremblay' },
      }),
    ]);
    expect(staff).toEqual({
      id: 'a',
      at: 10,
      actor: 'Sarah',
      action: 'Declined request',
      target: { type: 'waterBodyRequest', id: 'r1', label: 'Request' },
    });
    expect(machine?.actor).toBeNull();
    expect(machine?.action).toBe('Activated body');
    expect(machine?.target.label).toBe('Body');
    expect(author?.actor).toBe('Rob Tremblay');
  });

  it('names a skater saying “It’s open” on their own alert in full, and the erasure as the machine', () => {
    const [resolved, erased] = feedFromActions([
      row({
        id: 'd',
        action: 'author_resolve_access_alert',
        targetType: 'accessAlert',
        actor: { userId: 'r', username: 'rtremblay', displayName: 'Rob Tremblay' },
      }),
      row({ id: 'e', actor: null, action: 'erase', targetType: 'comment' }),
    ]);
    expect(resolved?.actor).toBe('Rob Tremblay');
    expect(resolved?.action).toBe('Said “It’s open” on their pinned alert');
    expect(erased?.actor).toBeNull();
    expect(erased?.action).toBe('Erased');
  });

  it('falls back to the username, and — for a verb this build has no words for — the verb in words', () => {
    const [r] = feedFromActions([
      row({
        action: 'set_ice_color' as ActionRow['action'],
        targetType: 'someNewThing' as ActionRow['targetType'],
        actor: { userId: 'u', username: 'matt', displayName: '  ' },
      }),
    ]);
    expect(r?.actor).toBe('matt');
    expect(r?.action).toBe('Set ice color');
    expect(r?.target.label).toBe('SomeNewThing');
    expect(verbWords('set_ice_color')).toBe('Set ice color');
  });

  it('writes every verb the table holds in the past tense, never its code name', () => {
    expect(actionWords('dismiss_flag')).toBe('Dismissed flag');
    expect(actionWords('grant_ledger_editor')).toBe('Gave ledger editing');
    expect(actionWords('promote_landmark')).toBe('Promoted landmark');
    expect(actionWords('create_sub_area')).toBe('Drew sub-area');
    expect(actionWords('set_lake_depth')).toBe('Set depth');
    expect(actionWords('overturn_verdict')).toBe('Overturned verdict');
  });
});
