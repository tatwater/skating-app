import { INBOX_AGE_FLOORS_DAYS } from '@skating/core';

import type {
  InboxItemView,
  InboxLanesView,
  InboxListPage,
  InboxRowView,
  InboxTodayView,
} from './inboxTypes';

/**
 * **The boards' Inbox, as reads would return it** (2.1–2.9) — for stories and tests only; the page
 * the app mounts draws only what a read returned (`fixturesStayInStories.test.ts`). The cast is the
 * boards' (Sarah Berman and Matt Steinberg on staff; Rob Tremblay, Kate Donovan, Luc Pelletier…),
 * the bodies are real. The clock is pinned at local midday, 14 Oct 2026, so ages read the same in
 * every zone a test runs in.
 */

/** "Now" for every Inbox fixture: local midday, so a day's edge never moves under a test. */
export const NOW = new Date(2026, 9, 14, 12, 0).getTime();
const H = 3_600_000;
const D = 24 * H;

type AnyId = never;
const id = (s: string) => s.padEnd(32, '0') as AnyId;

const person = (key: string, name: string, username: string, staff = false) => ({
  userId: id(`pr${key}`),
  displayName: name,
  username,
  deleted: false,
  isStaff: staff,
});

export const SARAH = person('sarah', 'Sarah Berman', 'sarah', true);
export const MATT = person('matt', 'Matt Steinberg', 'matt', true);
export const TEAGAN = person('teagan', 'Teagan Atwater', 'teagan', true);
export const ROB = person('rob', 'Rob Tremblay', 'rtremblay');
export const KATE = person('kate', 'Kate Donovan', 'kdonovan');
export const LUC = person('luc', 'Luc Pelletier', 'lpelletier');

const lockup = (p: typeof ROB, points = 41) => ({
  ...p,
  role: p.isStaff ? ('moderator' as const) : ('member' as const),
  trustClass: 'trusted' as const,
  points,
});

const body = (key: string, name: string, place: string | null, areaSqM = 4_400_000) => ({
  waterBodyId: id(`wb${key}`),
  name,
  place,
  type: 'lakePond' as const,
  areaSqM,
  removed: false,
  point: { lat: 43.63, lng: -72.15 },
});

export const MASCOMA = body('mascoma', 'Mascoma Lake', 'Enfield, NH');
export const TOMHANNOCK = body('tomhannock', 'Tomhannock Reservoir', 'Troy, NY', 6_677_000);
export const CASPIAN = body('caspian', 'Caspian Lake', 'Greensboro, VT');
export const NEWFOUND = body('newfound', 'Newfound Lake', 'Bristol, NH');
export const MOREY = body('morey', 'Lake Morey', 'Fairlee, VT');

const base = (key: string, lane: InboxRowView['lane'], facet: string, filedAgo: number) => ({
  itemId: id(`it${key}`) as InboxRowView['itemId'],
  lane,
  facet,
  filedAt: NOW - filedAgo,
  lastActivityAt: NOW - filedAgo,
  memberCount: 1,
  memberCountIsFloor: false,
  can: {},
  decided: null,
});

// ── Rows, one per lane as the boards draw them ───────────────────────────────────────────────

export const SAFETY_ROW: InboxRowView = {
  ...base('safety1', 'safety', 'reports', 4 * D),
  kind: 'flag',
  body: MASCOMA,
  reasons: ['unsafe_false_report'],
  target: {
    targetType: 'report',
    exists: true,
    summary: '“Black ice, 3½" at the beach, held fine”',
    moderationStatus: 'visible',
    withdrawn: false,
  },
  author: ROB,
  firstFiler: SARAH,
  autoFiled: false,
  occurrences: 1,
  can: { dismiss: null, hide: null, remove: null },
} as InboxRowView;

export const ACCESS_ROW: InboxRowView = {
  ...base('access1', 'accessReports', 'disputes', 4 * D),
  memberCount: 2,
  memberCountIsFloor: false,
  kind: 'access',
  body: TOMHANNOCK,
  reporters: 2,
  latestNote: 'gated at the dam road, no shoulder',
  disputes: { verdict: 'open', ruledAt: new Date(2026, 8, 12, 12).getTime() },
} as InboxRowView;

export const ADMIT_ROW: InboxRowView = {
  ...base('admit1', 'requests', 'admit', 3 * D),
  memberCount: 2,
  memberCountIsFloor: false,
  kind: 'request',
  body: null,
  requestKind: 'admit',
  askers: 2,
  firstAsker: KATE,
  note: 'the one behind the state forest lot',
  candidate: { name: 'Unnamed pond near Groton, VT', areaSqM: 165_924 },
  resolveError: null,
} as InboxRowView;

export const ADMIT_NO_MATCH_ROW: InboxRowView = {
  ...base('admit2', 'requests', 'admit', 2 * D),
  kind: 'request',
  body: null,
  requestKind: 'admit',
  askers: 1,
  firstAsker: LUC,
  note: null,
  candidate: null,
  resolveError: 'No 3DHP feature within 150 m',
} as InboxRowView;

export const ACTIVATE_ROW: InboxRowView = {
  ...base('activate1', 'requests', 'activate', 7 * H),
  memberCount: 2,
  memberCountIsFloor: false,
  kind: 'request',
  body: body('tarleton', 'Lake Tarleton', 'Piermont, NH'),
  requestKind: 'activate',
  askers: 2,
  firstAsker: LUC,
  note: null,
  candidate: null,
  resolveError: null,
} as InboxRowView;

export const PLACE_ROW: InboxRowView = {
  ...base('place1', 'placesAsked', 'landmarks', 5 * H),
  kind: 'place',
  body: NEWFOUND,
  placeKind: 'name_landmark',
  name: 'the Narrows',
  askers: 1,
  firstAsker: LUC,
  others: [],
  fromReport: true,
  lookalikeMeters: 640,
} as InboxRowView;

export const BAY_ROW: InboxRowView = {
  ...base('bay1', 'placesAsked', 'bays', 6 * H),
  memberCount: 3,
  memberCountIsFloor: false,
  kind: 'place',
  body: MASCOMA,
  placeKind: 'name_bay',
  name: 'Shaker cove',
  askers: 3,
  firstAsker: LUC,
  others: [KATE, person('jamie', 'Jamie Moreau', 'jm_ice')],
  fromReport: false,
  lookalikeMeters: null,
} as InboxRowView;

export const DRAWN_ROW: InboxRowView = {
  ...base('drawn1', 'drawnBodies', 'overlap', 2 * H),
  kind: 'drawn',
  body: body('drawn', 'User-drawn body', null),
  drawer: KATE,
  overlapShare: 0.92,
  overName: 'Caspian Lake',
  fromSkate: true,
} as InboxRowView;

export const ALERT_ROW: InboxRowView = {
  ...base('alert1', 'contentFlags', 'alerts', 6 * H),
  kind: 'flag',
  body: MOREY,
  reasons: ['other'],
  target: {
    targetType: 'accessAlert',
    exists: true,
    summary: '“Fairlee launch closed”',
    moderationStatus: null,
    withdrawn: false,
  },
  author: ROB,
  firstFiler: KATE,
  autoFiled: false,
  occurrences: 1,
} as InboxRowView;

export const PHOTO_ROW: InboxRowView = {
  ...base('photo1', 'contentFlags', 'photos', 2 * H),
  kind: 'flag',
  body: body('crystal', 'Crystal Lake', 'Enfield, NH'),
  reasons: ['inappropriate'],
  target: {
    targetType: 'photo',
    exists: true,
    summary: 'A photo on a Crystal Lake report',
    moderationStatus: 'visible',
    withdrawn: false,
  },
  author: KATE,
  firstFiler: SARAH,
  autoFiled: false,
  occurrences: 1,
} as InboxRowView;

export const AUTO_ROW: InboxRowView = {
  ...base('auto1', 'contentFlags', 'reports', 9 * H),
  kind: 'flag',
  body: MASCOMA,
  reasons: ['auto_low_quality'],
  target: {
    targetType: 'report',
    exists: true,
    summary: '“Solid everywhere, go”',
    moderationStatus: 'hidden',
    withdrawn: false,
  },
  author: ROB,
  firstFiler: null,
  autoFiled: true,
  occurrences: 4,
} as InboxRowView;

/** A flag on a comment its author has since deleted: withdrawn, not live content. */
export const WITHDRAWN_ROW: InboxRowView = {
  ...base('withdrawn1', 'contentFlags', 'comments', 26 * H),
  kind: 'flag',
  body: MOREY,
  reasons: ['harassment'],
  target: {
    targetType: 'comment',
    exists: true,
    summary: '“nobody asked you, stay off our lake”',
    moderationStatus: 'visible',
    withdrawn: true,
  },
  author: ROB,
  firstFiler: KATE,
  autoFiled: false,
  occurrences: 1,
} as InboxRowView;

export const TICKET_ROW: InboxRowView = {
  ...base('ticket1', 'support', 'account', 1 * D),
  kind: 'ticket',
  body: null,
  category: 'account',
  person: ROB,
  snippet: '“Appeal: my suspension”',
} as InboxRowView;

/** A row decided this week, as a lane's tail draws it. */
export function decidedRow(row: InboxRowView, by: typeof SARAH, ago: number, decision: string) {
  return {
    ...row,
    itemId: `${row.itemId}d` as InboxRowView['itemId'],
    can: {},
    decided: {
      at: NOW - ago,
      by: { userId: by.userId, displayName: by.displayName },
      decision,
      actionId: id('ma1'),
      byMe: false,
    },
  } as InboxRowView;
}

/** Every open row in the flow-through order (All open), the boards' nineteen cut to one a lane. */
export const ALL_OPEN_ROWS: InboxRowView[] = [
  SAFETY_ROW,
  ACCESS_ROW,
  ADMIT_ROW,
  ADMIT_NO_MATCH_ROW,
  ACTIVATE_ROW,
  BAY_ROW,
  PLACE_ROW,
  DRAWN_ROW,
  ALERT_ROW,
  PHOTO_ROW,
  TICKET_ROW,
];

export const SAFETY_TAIL: InboxRowView[] = [
  decidedRow(
    {
      ...SAFETY_ROW,
      target: {
        ...(SAFETY_ROW as { target: object }).target,
        summary: '“4 inches everywhere, go for it”',
      },
    } as InboxRowView,
    MATT,
    3 * D,
    'hidden',
  ),
];

/** One page of a lane, done. */
export function page(rows: InboxRowView[], extra: Partial<InboxListPage> = {}): InboxListPage {
  return {
    rows,
    isDone: true,
    continueCursor: 'end',
    scanBudgetSpent: false,
    pending: false,
    ...extra,
  };
}

// ── The lanes ────────────────────────────────────────────────────────────────────────────────

/**
 * A lane's age-option counts for its fixture: each floor counts the open items at least that old —
 * here the lane's oldest, so a floor past it counts none.
 */
function olderThan(oldestFiledAt: number, open: number) {
  return INBOX_AGE_FLOORS_DAYS.map((days) => ({
    days,
    count: { count: NOW - oldestFiledAt >= days * D ? Math.min(open, 1) : 0, capped: false },
  }));
}

/** The boards' lane counts: 19 open, 1,118 decided, 3 today. */
export const LANES: InboxLanesView = {
  lanes: [
    {
      lane: 'safety',
      open: 1,
      facets: { all: 1, reports: 1, hazards: 0, people: 0 },
      oldestFiledAt: NOW - 4 * D,
      olderThan: olderThan(NOW - 4 * D, 1),
    },
    {
      lane: 'accessReports',
      open: 3,
      facets: { all: 3, disputes: 1, new: 2 },
      oldestFiledAt: NOW - 4 * D,
      olderThan: olderThan(NOW - 4 * D, 3),
    },
    {
      lane: 'requests',
      open: 6,
      facets: { all: 6, admit: 2, activate: 2, restore: 1, contest_access: 1, takedown: 0 },
      oldestFiledAt: NOW - 6 * D,
      olderThan: olderThan(NOW - 6 * D, 6),
    },
    {
      lane: 'placesAsked',
      open: 4,
      facets: { all: 4, bays: 2, landmarks: 2 },
      oldestFiledAt: NOW - 2 * D,
      olderThan: olderThan(NOW - 2 * D, 4),
    },
    {
      lane: 'drawnBodies',
      open: 1,
      facets: { all: 1, overlap: 1, newWater: 0 },
      oldestFiledAt: NOW - 2 * H,
      olderThan: olderThan(NOW - 2 * H, 1),
    },
    {
      lane: 'contentFlags',
      open: 2,
      facets: { all: 2, reports: 0, comments: 0, alerts: 1, photos: 1, people: 0 },
      oldestFiledAt: NOW - 6 * H,
      olderThan: olderThan(NOW - 6 * H, 2),
    },
    {
      lane: 'support',
      open: 2,
      facets: { all: 2, account: 1, bug: 1, safety: 0, other: 0 },
      oldestFiledAt: NOW - 2 * D,
      olderThan: olderThan(NOW - 2 * D, 2),
    },
  ],
  allOpen: 19,
  decided: 1118,
  today: { count: 3, capped: false },
  medianFiledAt: NOW - 1.5 * D,
  pending: false,
};

/** Inbox zero (2.9): nothing open, 1,137 decided, 22 today. */
export const ZERO_LANES: InboxLanesView = {
  ...LANES,
  lanes: LANES.lanes.map((l) => ({
    ...l,
    open: 0,
    facets: Object.fromEntries(Object.keys(l.facets).map((k) => [k, 0])),
    oldestFiledAt: null,
  })),
  allOpen: 0,
  decided: 1137,
  today: { count: 22, capped: false },
  medianFiledAt: null,
};

/** The lanes while the server prepares its stored items. */
export const PENDING_LANES: InboxLanesView = { ...LANES, pending: true };

/** A moderator's lanes: no Support (D37). */
export const MODERATOR_LANES: InboxLanesView = {
  ...LANES,
  lanes: LANES.lanes.filter((l) => l.lane !== 'support'),
  allOpen: 17,
};

// ── The day (2.9) ────────────────────────────────────────────────────────────────────────────

const midnight = new Date(2026, 9, 14).getTime();
// The board's day, ending at 15:02, moved three hours earlier so it ends before the pinned noon.
const at = (h: number, m = 0) => midnight + (h - 3) * H + (m - 4) * 60_000;

/** The zero board's day: twenty open, two filed, twenty-two decided by 11:58 (the board's 15:02). */
export const ZERO_TODAY: InboxTodayView = {
  since: midnight,
  filed: [
    { at: at(9, 10), lane: 'requests' },
    { at: at(10, 30), lane: 'placesAsked' },
  ],
  filedCapped: false,
  decided: [
    [9, 35, 'safety'],
    [10, 10, 'accessReports'],
    [11, 5, 'requests'],
    [11, 40, 'requests'],
    [11, 46, 'requests'],
    [11, 58, 'accessReports'],
    [12, 7, 'requests'],
    [12, 16, 'placesAsked'],
    [12, 28, 'requests'],
    [12, 39, 'contentFlags'],
    [12, 51, 'requests'],
    [13, 0, 'placesAsked'],
    [13, 14, 'requests'],
    [13, 26, 'support'],
    [13, 37, 'placesAsked'],
    [13, 49, 'contentFlags'],
    [13, 58, 'requests'],
    [14, 10, 'drawnBodies'],
    [14, 21, 'accessReports'],
    [14, 34, 'placesAsked'],
    [14, 48, 'contentFlags'],
    [15, 2, 'support'],
  ].map(([h, m, lane]) => ({
    at: at(h as number, m as number),
    filedAt: at(h as number, m as number) - 1.5 * D,
    lane: lane as InboxTodayView['decided'][number]['lane'],
    decision: 'approved' as const,
  })),
  decidedCapped: false,
  openAtStart: 20,
  pending: false,
};

// ── Items (`inbox.item`), for the frame and the placeholder ───────────────────────────────────

const itemBase = (row: InboxRowView) => ({
  itemId: row.itemId,
  lane: row.lane,
  facet: row.facet,
  filedAt: row.filedAt,
  lastActivityAt: row.lastActivityAt,
  memberCount: row.memberCount,
  memberCountIsFloor: row.memberCountIsFloor,
  can: row.can,
  decided: row.decided,
});

const reportSubject = {
  reportId: id('rp1'),
  body: MASCOMA,
  point: { lat: 43.6309, lng: -72.1572 },
  place: 'Enfield, NH',
  skateStartTime: new Date(2026, 9, 10, 15, 40).getTime(),
  skateEndTime: new Date(2026, 9, 10, 17, 5).getTime(),
  observedFrom: 'on_ice',
  notes:
    'Black ice over most of the north end, 3½" where I drilled off the town beach and it held fine.',
  claims: {
    iceThickness: null,
    iceTypes: ['black'],
    surfaceTags: [],
    sightings: [],
    suitability: null,
    skateQuality: null,
    snow: null,
  },
  photoCount: 0,
  moderationStatus: 'visible',
  ratings: { up: 0, down: 2 },
};

/** 2.1's item: a safety flag on a report. */
export const SAFETY_ITEM = {
  ...itemBase(SAFETY_ROW),
  kind: 'flag',
  target: {
    targetType: 'report',
    targetId: 'rp1',
    exists: true,
    summary: '“Black ice, 3½" at the beach, held fine”',
    moderationStatus: 'visible',
    report: reportSubject,
  },
  flags: [
    {
      flagId: id('fl1'),
      reason: 'unsafe_false_report',
      note: 'He was on about 2 inches. I measured 1¾ at the beach an hour later and it was cracking under the kids.',
      filedAt: new Date(2026, 9, 10, 18, 2).getTime(),
      status: 'open',
      filer: lockup(SARAH, 58),
      autoFiled: false,
      occurrences: 1,
      lastOccurrenceAt: null,
      prior: null,
    },
  ],
  author: null,
} as unknown as InboxItemView;

/** 2.2's item: access reports disputing a ruling. */
export const ACCESS_ITEM = {
  ...itemBase(ACCESS_ROW),
  kind: 'access',
  body: TOMHANNOCK,
  reports: [],
  ruling: {
    verdict: 'open',
    ruledAt: new Date(2026, 8, 12, 12).getTime(),
    by: TEAGAN,
    note: 'The town beach lot stays open in winter',
  },
  dismissedByRuling: [],
} as unknown as InboxItemView;

/** 2.3's item: an admit with a catalog match. */
export const ADMIT_ITEM = {
  ...itemBase(ADMIT_ROW),
  kind: 'request',
  requestKind: 'admit',
  body: null,
  asks: [
    {
      requestId: id('rq1'),
      asker: lockup(KATE),
      askedAt: NOW - 3 * D,
      note: 'the one behind the state forest lot',
      name: null,
      coord: { lat: 44.28, lng: -72.27 },
      status: 'open',
      fromReport: null,
      activityId: null,
    },
  ],
  candidate: null,
  resolveError: null,
} as unknown as InboxItemView;

/** 2.8's item: a support ticket. */
export const TICKET_ITEM = {
  ...itemBase(TICKET_ROW),
  kind: 'ticket',
  ticket: {
    ticketId: id('tk1'),
    category: 'account',
    body: 'I was suspended for a report I stand by. I measured it myself.',
    createdAt: NOW - 1 * D,
    status: 'open',
    context: null,
    resolvedAt: null,
    resolvedBy: null,
  },
  messages: [],
  person: null,
} as unknown as InboxItemView;

/** A flag on a photo (2.7's kind; its handler isn't here yet). */
export const PHOTO_ITEM = {
  ...itemBase(PHOTO_ROW),
  kind: 'flag',
  target: {
    targetType: 'photo',
    targetId: 'ph1',
    exists: true,
    summary: 'A photo on a Crystal Lake report',
    moderationStatus: 'visible',
    withdrawnAt: null,
    withdrawal: null,
    photo: {
      photoId: id('ph1'),
      caption: null,
      takenAt: null,
      createdAt: NOW - 3 * H,
      url: null,
      thumbUrl: null,
      reportId: null,
      body: null,
      siblings: [],
      indexOnReport: null,
    },
  },
  flags: [
    {
      flagId: id('fl9'),
      reason: 'inappropriate',
      note: null,
      filedAt: NOW - 2 * H,
      status: 'open',
      filer: lockup(SARAH, 58),
      autoFiled: false,
      occurrences: 1,
      lastOccurrenceAt: null,
      prior: null,
    },
  ],
  author: null,
} as unknown as InboxItemView;

/** A landmark ask (2.4's kind) on Newfound Lake. */
export const PLACE_ITEM = {
  ...itemBase(PLACE_ROW),
  kind: 'place',
  placeKind: 'name_landmark',
  body: NEWFOUND,
  asks: [],
  drawnSubAreaId: null,
  lookalikes: [],
} as unknown as InboxItemView;

/** A drawn body over Caspian Lake (2.5's kind). */
export const DRAWN_ITEM = {
  ...itemBase(DRAWN_ROW),
  kind: 'drawn',
  body: body('drawn', 'User-drawn body', null),
  drawer: lockup(KATE),
  overlap: null,
  fromReport: null,
} as unknown as InboxItemView;

/** An item decided by a colleague. */
export function decidedItem(
  item: InboxItemView,
  by: typeof SARAH,
  ago: number,
  decision: string,
  byMe = false,
): InboxItemView {
  return {
    ...item,
    can: {},
    decided: {
      at: NOW - ago,
      by: { userId: by.userId, displayName: by.displayName },
      decision,
      actionId: id('ma2'),
      byMe,
    },
  } as InboxItemView;
}
