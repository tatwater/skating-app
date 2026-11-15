/**
 * Board fixtures for the person page (8.1, 8.2, 8.5, 8.6) and its states — **stories and tests
 * only** (`fixturesStayInStories.test.ts` holds the app to that). The clock is pinned at local
 * midday on Wed 14 Oct 2026, the boards' day, so every runner reads the same words.
 */
import type { Id } from '@skating/convex/dataModel';

import type {
  ActionRow,
  Can,
  DecisionsRead,
  HistoryRead,
  PersonRead,
  StaffSeasonRead,
  StaffStatsRead,
  TrendRead,
} from './personModel';

const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();

/** The boards' day: Wed 14 Oct 2026, local midday. */
export const NOW = at(10, 14);

export const yes = (needsReason = false): Can => ({ ok: true, needsReason });
export const no = (why: string): Can => ({ ok: false, why });

const uid = (s: string) => s.padEnd(32, '0') as Id<'profiles'>;
export const IDS = {
  rob: uid('rob'),
  sarah: uid('sarah'),
  teagan: uid('teagan'),
  matt: uid('matt'),
  pat: uid('pat'),
} as const;

export const SELF_REFUSAL = 'You cannot moderate your own account';
export const LAST_EDITOR =
  'They are the last person who can edit the ledger; give another admin ledger editing first';

type CanBase = Omit<
  PersonRead['can'],
  'extend' | 'restore' | 'flaggingOn' | 'bountyRaise' | 'bountyLower'
>;

/**
 * `can` with the levers a fixture derives rather than spells out: a new window answers as `suspend`
 * does, the give-backs as `restrict` (or `flaggingOff`) does but ask no reason (D226), and lowering
 * the bounty limit asks one where raising it doesn't.
 */
export function canOf(base: CanBase): PersonRead['can'] {
  const giveBack = base.restrict.ok ? yes(false) : base.restrict;
  return {
    ...base,
    extend: base.suspend,
    restore: { reports: giveBack, hazards: giveBack, comments: giveBack },
    flaggingOn: base.flaggingOff.ok ? yes(false) : base.flaggingOff,
    bountyRaise: giveBack,
    bountyLower: base.restrict,
  };
}

/** Everything allowed, to a member, by an admin who holds the ledger. */
const CAN_ALL: PersonRead['can'] = canOf({
  restrict: yes(true),
  flaggingOff: yes(true),
  suspend: yes(true),
  ban: yes(true),
  lift: yes(false),
  role: { admin: yes(false), moderator: yes(false), member: no('This is their role now.') },
  ledger: null,
});

/** A person read, from a member's defaults. */
export function personOf(over: Partial<PersonRead> = {}): PersonRead {
  return {
    userId: IDS.rob,
    displayName: 'Rob Tremblay',
    username: 'rtremblay',
    profileImageUrl: null,
    profileVisibility: 'public',
    role: 'member',
    status: 'active',
    trustClass: 'trusted',
    createdAt: at(1, 14, 12, 0),
    leavingUntil: null,
    deletedAt: null,
    statusNote: null,
    bountySeason: null,
    rightsSince: { reports: null, hazards: null, comments: null, flagging: null },
    rightsSinceCapped: false,
    publicProfile: { opens: true, private: false, path: '/u/rtremblay' },
    strip: {
      contradictions: 0,
      openFlags: { onUser: { count: 0, capped: false }, onContent: { count: 0, capped: false } },
      trustPoints: null,
    },
    rights: {
      reports: true,
      hazards: true,
      comments: true,
      flagging: true,
      bountyLimit: null,
      defaultBountyLimit: 3,
      effectiveBountyLimit: 3,
      restrictions: [],
      flagsFiled: { count: 0, capped: false },
    },
    pending: [],
    open: {
      flags: [],
      flagsCapped: false,
      flagLabelsCapped: false,
      appeals: [],
      appealsCapped: false,
    },
    hidden: {
      total: 0,
      byKind: { report: 0, post: 0, comment: 0, hazard: 0, accessAlert: 0 },
      capped: false,
    },
    ledger: null,
    can: CAN_ALL,
    ...over,
  };
}

const ref = (id: Id<'profiles'>, displayName: string, username: string) => ({
  userId: id,
  displayName,
  username,
  profileImageUrl: null,
});
export const MATT = ref(IDS.matt, 'Matt Steinberg', 'matt');
export const SARAH = ref(IDS.sarah, 'Sarah Berman', 'sarah');
export const TEAGAN = ref(IDS.teagan, 'Teagan Atwater', 'teagan');

// ── 8.1 · Rob Tremblay, suspended, opened by Teagan ─────────────────────────────────────────

export const ROB: PersonRead = personOf({
  status: 'suspended',
  statusNote: {
    action: 'suspend',
    at: at(10, 10, 19, 48),
    by: MATT,
    via: null,
    reason: 'Second unsafe report in a week; cooling off',
    suspendedUntil: at(10, 15, 19, 48),
    lapsed: false,
    atCapped: false,
  },
  strip: {
    contradictions: 3,
    openFlags: { onUser: { count: 0, capped: false }, onContent: { count: 1, capped: false } },
    trustPoints: 41,
  },
  rights: {
    reports: true,
    hazards: true,
    comments: false,
    flagging: true,
    bountyLimit: 1,
    defaultBountyLimit: 3,
    effectiveBountyLimit: 1,
    restrictions: ['comments', 'bounties'],
    flagsFiled: { count: 0, capped: false },
  },
  open: {
    flags: [
      {
        flagId: 'flag1' as Id<'contentFlags'>,
        reason: 'unsafe_false_report',
        targetType: 'report',
        targetId: 'report1',
        status: 'open',
        createdAt: at(10, 12, 11, 0),
      },
    ],
    flagsCapped: false,
    flagLabelsCapped: false,
    appeals: [
      {
        ticketId: 'ticket1' as Id<'supportTickets'>,
        status: 'open',
        createdAt: at(10, 13, 10, 0),
        body: 'The second report was right; the ice had been cut',
      },
    ],
    appealsCapped: false,
  },
  hidden: {
    total: 4,
    byKind: { report: 2, post: 0, comment: 2, hazard: 0, accessAlert: 0 },
    capped: false,
  },
});

export const ROB_TREND: TrendRead = {
  total: { count: 14, capped: false },
  kept: { count: 12, capped: false },
  hidden: { count: 2, capped: false },
  edited: { count: 1, capped: false },
  months: [
    ['2026-02', 5, 0],
    ['2026-03', 3, 1],
    ['2026-04', 1, 0],
    ['2026-05', 0, 0],
    ['2026-06', 0, 0],
    ['2026-07', 0, 0],
    ['2026-08', 0, 0],
    ['2026-09', 0, 0],
    ['2026-10', 3, 1],
  ].map(([month, kept, hidden]) => ({
    month: month as string,
    kept: kept as number,
    hidden: hidden as number,
  })),
  monthsCapped: false,
};

let n = 0;
/** An audit row as History draws it. */
export function rowOf(over: Partial<ActionRow> & Pick<ActionRow, 'action'>): ActionRow {
  n += 1;
  return {
    id: `action${n}` as Id<'moderationActions'>,
    targetType: 'user',
    targetId: IDS.rob,
    reason: '',
    reasonGiven: true,
    createdAt: NOW,
    actor: TEAGAN,
    targetLabel: 'Rob Tremblay',
    undo: { state: 'unavailable', why: 'Not undoable' },
    ...over,
  };
}

export const ROB_HISTORY: HistoryRead = {
  rows: [
    rowOf({
      action: 'suspend',
      createdAt: at(10, 10, 19, 48),
      actor: MATT,
      reason: 'Second unsafe report in a week; cooling off',
      metadata: { suspendedUntil: at(10, 15, 19, 48) },
      undo: { state: 'available', needsReason: false },
    }),
    rowOf({
      action: 'hide',
      targetType: 'report',
      targetId: 'report2',
      targetLabel: 'Mascoma Lake · 10 Oct',
      createdAt: at(10, 10, 19, 41),
      actor: MATT,
      reason: 'Second unsafe claim this week',
      undo: { state: 'available', needsReason: false },
    }),
    rowOf({
      action: 'set_posting_permission',
      createdAt: at(10, 2, 9, 12),
      actor: SARAH,
      reason: 'Warned twice about name-calling',
      metadata: { permission: 'comments', allowed: false, prev: { allowed: true } },
      undo: { state: 'overtaken', byActionId: 'action99' as Id<'moderationActions'> },
    }),
    rowOf({
      action: 'set_posting_permission',
      createdAt: at(9, 28, 8, 5),
      actor: TEAGAN,
      via: 'seed-bounties',
      reason: 'Asks on lakes he just reported',
      metadata: { permission: 'bounties', limit: 1, prev: { limit: null } },
      undo: { state: 'unavailable', why: 'Changed since' },
    }),
  ],
  capped: false,
  pending: [],
  createdAt: at(1, 14, 12, 0),
};

// ── 8.2 · Sarah Berman, admin, by Teagan (who holds the ledger) ─────────────────────────────

export const SARAH_PAGE: PersonRead = personOf({
  userId: IDS.sarah,
  displayName: 'Sarah Berman',
  username: 'sarah',
  role: 'admin',
  trustClass: 'leader',
  createdAt: at(1, 9),
  strip: {
    contradictions: 0,
    openFlags: { onUser: { count: 0, capped: false }, onContent: { count: 1, capped: false } },
    trustPoints: 164,
  },
  rights: {
    reports: true,
    hazards: true,
    comments: true,
    flagging: true,
    bountyLimit: null,
    defaultBountyLimit: 3,
    effectiveBountyLimit: 3,
    restrictions: [],
    flagsFiled: { count: 4, capped: false },
  },
  open: {
    flags: [
      {
        flagId: 'flag2' as Id<'contentFlags'>,
        reason: 'other',
        targetType: 'report',
        targetId: 'report3',
        status: 'open',
        createdAt: at(10, 14, 7, 0),
      },
    ],
    flagsCapped: false,
    flagLabelsCapped: false,
    appeals: [],
    appealsCapped: false,
  },
  ledger: { editor: false, last: false, since: null, sinceCapped: false },
  can: canOf({
    restrict: yes(true),
    flaggingOff: no('Staff can always flag, so flagging can’t be switched off for them.'),
    suspend: yes(true),
    ban: yes(true),
    lift: yes(false),
    role: { admin: no('This is their role now.'), moderator: yes(true), member: yes(true) },
    ledger: { grant: yes(false), revoke: no('They cannot edit the ledger') },
  }),
});

export const SARAH_TREND: TrendRead = {
  ...ROB_TREND,
  total: { count: 9, capped: false },
  kept: { count: 9, capped: false },
  hidden: { count: 0, capped: false },
  edited: { count: 1, capped: false },
  months: ROB_TREND.months.map((m, i) => ({
    ...m,
    kept: [3, 2, 1, 0, 0, 0, 0, 0, 3][i] ?? 0,
    hidden: 0,
  })),
};

const weeksOf = (counts: number[]): StaffStatsRead['weeks'] => {
  const end = Date.UTC(2026, 9, 15);
  return counts.map((count, i) => ({
    from: end - (counts.length - i) * 7 * 86_400_000,
    count,
    capped: false,
  }));
};

export const SARAH_STATS: StaffStatsRead = {
  decisions: {
    thisWeek: { count: 18, capped: false },
    undoneByOthers: { count: 2, capped: false, by: [], byMore: 0 },
  },
  timeToDecide: { medianMs: 41 * 60_000, decided: 7, capped: false },
  staffSince: { at: at(1, 12), role: 'moderator' },
  roleSince: { at: at(3, 3), role: 'admin' },
  tenureCapped: false,
  pending: [],
  weeks: weeksOf([6, 9, 4, 11, 7, 12, 9, 14, 18]),
};

export const SEASON: StaffSeasonRead = {
  season: 2026,
  opensOn: '2026-10-01',
  empty: false,
  overturned: { count: 1, capped: false },
  pending: [],
};

export const SARAH_HISTORY: HistoryRead = {
  rows: [
    rowOf({
      action: 'grant_role',
      targetId: IDS.sarah,
      targetLabel: 'Sarah Berman',
      createdAt: at(3, 3, 10, 0),
      reason: 'Covers weekends from now on',
      metadata: { role: 'admin', priorRole: 'moderator' },
    }),
    rowOf({
      action: 'grant_role',
      targetId: IDS.sarah,
      targetLabel: 'Sarah Berman',
      createdAt: at(1, 12, 10, 0),
      reason: 'Promoted',
      reasonGiven: false,
      metadata: { role: 'moderator', priorRole: 'member' },
    }),
  ],
  capped: false,
  pending: [],
  createdAt: at(1, 9),
};

export const SARAH_DECISIONS: DecisionsRead = {
  rows: [
    rowOf({
      action: 'decline_request',
      targetType: 'waterBodyRequest',
      targetId: 'req1',
      targetLabel: '“Shaker cove”, Mascoma Lake',
      createdAt: at(10, 14, 11, 41),
      actor: SARAH,
      reason: 'Already named Shaker Bay',
      undo: { state: 'available', needsReason: true },
    }),
    rowOf({
      action: 'dismiss_flag',
      targetType: 'contentFlag',
      targetId: 'flag9',
      targetLabel: 'A flag on a comment · Lake Morey',
      createdAt: at(10, 14, 11, 5),
      actor: SARAH,
      undo: { state: 'undone', byActionId: 'action-undo' as Id<'moderationActions'> },
    }),
    rowOf({
      action: 'hide',
      targetType: 'comment',
      targetId: 'comment1',
      targetLabel: 'Lake Morey',
      createdAt: at(10, 12, 9, 30),
      actor: SARAH,
      reason: 'Spam link',
    }),
    rowOf({
      action: 'set_posting_permission',
      targetId: IDS.pat,
      targetLabel: 'Pat Lacasse',
      createdAt: at(10, 11, 16, 0),
      actor: SARAH,
      reason: 'Pinned a hazard on every lake in the county',
      metadata: { permission: 'hazards', allowed: false },
    }),
  ],
  isDone: false,
  capped: false,
  continueCursor: 'cursor1',
};

// ── 8.5 · Sarah holds the ledger now ────────────────────────────────────────────────────────

export const SARAH_GRANTED: PersonRead = {
  ...SARAH_PAGE,
  ledger: { editor: true, last: false, since: at(10, 14, 11, 52), sinceCapped: false },
  can: {
    ...SARAH_PAGE.can,
    ledger: { grant: no('They can already edit the ledger'), revoke: yes(true) },
  },
};

export const SARAH_GRANTED_HISTORY: HistoryRead = {
  ...SARAH_HISTORY,
  rows: [
    rowOf({
      action: 'grant_ledger_editor',
      targetId: IDS.sarah,
      targetLabel: 'Sarah Berman',
      createdAt: at(10, 14, 11, 52),
      reason: 'Given',
      reasonGiven: false,
      undo: { state: 'available', needsReason: true },
    }),
    ...SARAH_HISTORY.rows,
  ],
};

// ── 8.6 · Teagan's own page ─────────────────────────────────────────────────────────────────

export const TEAGAN_PAGE: PersonRead = personOf({
  userId: IDS.teagan,
  displayName: 'Teagan Atwater',
  username: 'teagan',
  role: 'admin',
  trustClass: 'trusted',
  createdAt: at(1, 2),
  strip: {
    contradictions: 0,
    openFlags: { onUser: { count: 0, capped: false }, onContent: { count: 0, capped: false } },
    trustPoints: 27,
  },
  rights: {
    reports: true,
    hazards: true,
    comments: true,
    flagging: true,
    bountyLimit: null,
    defaultBountyLimit: 3,
    effectiveBountyLimit: 3,
    restrictions: [],
    flagsFiled: { count: 2, capped: false },
  },
  ledger: { editor: true, last: true, since: at(1, 2, 12, 5), sinceCapped: false },
  can: canOf({
    restrict: no(SELF_REFUSAL),
    flaggingOff: no(SELF_REFUSAL),
    suspend: no(SELF_REFUSAL),
    ban: no(SELF_REFUSAL),
    lift: no(SELF_REFUSAL),
    role: {
      admin: no('You cannot change your own role'),
      moderator: no('You cannot change your own role'),
      member: no('You cannot change your own role'),
    },
    ledger: { grant: no('They can already edit the ledger'), revoke: no(LAST_EDITOR) },
  }),
});

export const TEAGAN_STATS: StaffStatsRead = {
  ...SARAH_STATS,
  decisions: {
    thisWeek: { count: 31, capped: false },
    undoneByOthers: { count: 1, capped: false, by: [], byMore: 0 },
  },
  timeToDecide: { medianMs: 22 * 60_000, decided: 12, capped: false },
  staffSince: { at: at(1, 2), role: 'admin' },
  roleSince: { at: at(1, 2), role: 'admin' },
  weeks: weeksOf([12, 15, 9, 20, 18, 25, 22, 27, 31]),
};

export const TEAGAN_HISTORY: HistoryRead = {
  rows: [
    rowOf({
      action: 'grant_ledger_editor',
      targetId: IDS.teagan,
      targetLabel: 'Teagan Atwater',
      createdAt: at(1, 2, 12, 5),
      actor: null,
      reason: 'Seeded',
      reasonGiven: false,
    }),
  ],
  capped: false,
  pending: [],
  createdAt: at(1, 2),
};

export const TEAGAN_DECISIONS: DecisionsRead = {
  rows: [
    rowOf({
      action: 'approve_request',
      targetType: 'waterBodyRequest',
      targetId: 'req2',
      targetLabel: '“Black Point”, Mascoma Lake',
      createdAt: at(10, 14, 11, 2),
      undo: { state: 'available', needsReason: true },
    }),
    rowOf({
      action: 'restore',
      targetType: 'comment',
      targetId: 'comment2',
      targetLabel: 'Rob Tremblay, on Jamie Moreau’s report',
      createdAt: at(10, 14, 10, 52),
      undo: { state: 'available', needsReason: true },
    }),
    rowOf({
      action: 'set_posting_permission',
      targetId: IDS.rob,
      targetLabel: 'Rob Tremblay',
      createdAt: at(10, 14, 9, 18),
      reason: 'Asks on lakes he just reported',
      metadata: { permission: 'bounties', limit: 1 },
    }),
  ],
  isDone: true,
  capped: false,
  continueCursor: '',
};

// ── Moderator viewing an admin (Matt on Sarah's page) ────────────────────────────────────────

export const SARAH_BY_MODERATOR: PersonRead = {
  ...SARAH_PAGE,
  strip: { ...SARAH_PAGE.strip, trustPoints: null },
  open: { ...SARAH_PAGE.open, appeals: null },
  ledger: null,
  can: canOf({
    restrict: no('Only an admin can moderate an admin'),
    flaggingOff: no('Only an admin can moderate an admin'),
    suspend: no('Only an admin can moderate an admin'),
    ban: no('Only an admin can moderate an admin'),
    lift: no('Only an admin can moderate an admin'),
    role: {
      admin: no('Only an admin can change roles.'),
      moderator: no('Only an admin can change roles.'),
      member: no('Only an admin can change roles.'),
    },
    ledger: null,
  }),
};

// ── The three answers that aren't numbers ───────────────────────────────────────────────────

/** Still being prepared after a deploy: the subject and undo-chain backfills haven't run. */
export const ROB_PENDING: PersonRead = { ...ROB, pending: ['flagSubjects'] };
export const STATS_PENDING: StaffStatsRead = { ...SARAH_STATS, pending: ['undoChains'] };
export const SEASON_PENDING: StaffSeasonRead = { ...SEASON, pending: ['undoChains'] };
export const HISTORY_PENDING: HistoryRead = { ...ROB_HISTORY, pending: ['flagSubjects'] };

/** Read to their caps: floors, "N+". */
export const ROB_CAPPED: PersonRead = {
  ...ROB,
  strip: {
    ...ROB.strip,
    openFlags: { onUser: { count: 50, capped: true }, onContent: { count: 50, capped: true } },
  },
  rights: { ...ROB.rights, flagsFiled: { count: 100, capped: true } },
  open: { ...ROB.open, flagsCapped: true },
  hidden: { ...ROB.hidden, total: 500, capped: true },
};
export const TREND_CAPPED: TrendRead = {
  ...ROB_TREND,
  total: { count: 3000, capped: true },
  kept: { count: 2900, capped: true },
  hidden: { count: 100, capped: true },
  edited: { count: 40, capped: true },
  monthsCapped: true,
};
export const STATS_CAPPED: StaffStatsRead = {
  ...SARAH_STATS,
  decisions: {
    thisWeek: { count: 2000, capped: true },
    undoneByOthers: { count: 3, capped: true, by: [], byMore: 0 },
  },
  timeToDecide: { medianMs: null, decided: 40, capped: true },
  staffSince: null,
  roleSince: null,
  tenureCapped: true,
  weeks: SARAH_STATS.weeks.map((w, i) => ({ ...w, capped: i === 8 })),
};
export const HISTORY_CAPPED: HistoryRead = { ...ROB_HISTORY, capped: true };

/** Nothing on record: `null` everywhere a figure can be. */
export const ROB_UNRECORDED: PersonRead = {
  ...ROB,
  trustClass: null,
  statusNote: {
    action: 'suspend',
    at: null,
    by: null,
    via: null,
    reason: null,
    suspendedUntil: at(10, 15, 19, 48),
    lapsed: false,
    atCapped: false,
  },
  strip: { ...ROB.strip, contradictions: null },
};
export const STATS_UNRECORDED: StaffStatsRead = {
  ...SARAH_STATS,
  timeToDecide: { medianMs: null, decided: 0, capped: false },
  staffSince: null,
  roleSince: null,
};
export const SEASON_UNRECORDED: StaffSeasonRead = { ...SEASON, overturned: null };
/** Between 1 July and 1 October: the season is honestly empty. */
export const SEASON_EMPTY: StaffSeasonRead = {
  ...SEASON,
  empty: true,
  overturned: null,
};

// ── Accounts on their way out ───────────────────────────────────────────────────────────────

export const ROB_LEAVING: PersonRead = {
  ...personOf(),
  leavingUntil: at(11, 2, 12, 0),
  can: {
    ...CAN_ALL,
    suspend: no('Leaving'),
    extend: no('Leaving'),
    ban: no('Leaving'),
    lift: no('Leaving'),
  },
};
export const ROB_DELETED: PersonRead = {
  ...personOf(),
  status: 'deleted',
  trustClass: null,
  deletedAt: at(10, 3),
  profileVisibility: 'private',
  can: canOf({
    restrict: no('This account is deleted, so there is nothing to restrict.'),
    flaggingOff: no('This account is deleted, so there is nothing to restrict.'),
    suspend: no('This account is deleted, so it can’t be suspended or banned.'),
    ban: no('This account is deleted, so it can’t be suspended or banned.'),
    lift: no('This account is deleted, so there is nothing to lift.'),
    role: {
      admin: no('This account is being deleted, so its role can’t change.'),
      moderator: no('This account is being deleted, so its role can’t change.'),
      member: no('This account is being deleted, so its role can’t change.'),
    },
    ledger: null,
  }),
};
