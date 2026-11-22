import type { Id, TableNames } from '@skating/convex/dataModel';
import { zonedInstant } from '@skating/core';

import type {
  AlertSubjectData,
  AroundItData,
  AroundReportData,
  AuthorBlockData,
  ClaimWeatherData,
  FlagItem,
  FlagMember,
  InboxWriteResultData,
  PersonLockupData,
  ReportSubjectData,
} from './flagTypes';

/**
 * Boards 2.1 (Safety · Unsafe report, its drawer) and 2.6 (Content flags · Access alert), as data,
 * plus every state no board draws. The clock is pinned at local midday on Wed 14 Oct 2026, as the
 * boards' "4 days ago" and "6 hours ago" read from it. Stories only: nothing here reaches the app.
 */

const id = <T extends TableNames>(s: string) => s as Id<T>;

/** The boards' zone: every fixture moment is an absolute instant in it, whatever zone runs. */
export const BOARD_ZONE = 'America/New_York';

/** A moment in 2026 (`month` 1-based), the boards' wall clock, as an absolute instant. */
export const at = (month: number, day: number, hour: number, minute = 0) =>
  zonedInstant(2026, month, day, hour * 60 + minute, BOARD_ZONE);

/** The boards' "now": Wed 14 Oct 2026, midday in the boards' zone. */
export const BOARD_NOW = at(10, 14, 12);

const cm = (inches: number) => inches * 2.54;

// ── People ─────────────────────────────────────────────────────────────────────────────────────

const person = (
  key: string,
  displayName: string,
  username: string,
  over: Partial<PersonLockupData> = {},
): PersonLockupData => ({
  userId: id<'profiles'>(`p_${key}`),
  displayName,
  username,
  deleted: false,
  isStaff: false,
  role: 'member',
  trustClass: 'trusted',
  points: 40,
  ...over,
});

export const SARAH = person('sarah', 'Sarah Berman', 'sarah', {
  isStaff: true,
  role: 'moderator',
  points: 58,
});
export const ROB = person('rob', 'Rob Tremblay', 'rtremblay', { points: 41 });
export const KATE = person('kate', 'Kate Donovan', 'kdonovan', { points: 22 });
export const LUC = person('luc', 'Luc Pelletier', 'lpelletier', { points: 31 });
export const JAMIE = person('jamie', 'Jamie Moreau', 'jm_ice', { points: 64 });
export const DANA = person('dana', 'Dana Whitlock', 'dwhitlock', { trustClass: 'new', points: 6 });
export const MATT = person('matt', 'Matt Steinberg', 'matt', { isStaff: true, role: 'moderator' });
export const TEAGAN = person('teagan', 'Teagan Atwater', 'teagan', {
  isStaff: true,
  role: 'admin',
});

const ref = (p: PersonLockupData) => ({
  userId: p.userId,
  displayName: p.displayName,
  username: p.username,
  deleted: p.deleted,
  isStaff: p.isStaff,
});

// ── Bodies ─────────────────────────────────────────────────────────────────────────────────────

export const MASCOMA = {
  waterBodyId: id<'waterBodies'>('wb_mascoma'),
  name: 'Mascoma Lake',
  place: 'Enfield, NH',
  type: 'lakePond' as const,
  areaSqM: 4_570_000,
  removed: false,
  point: { lat: 43.6309, lng: -72.1572 },
};

export const MOREY = {
  waterBodyId: id<'waterBodies'>('wb_morey'),
  name: 'Lake Morey',
  place: 'Fairlee, VT',
  type: 'lakePond' as const,
  areaSqM: 2_200_000,
  removed: false,
  point: { lat: 43.917, lng: -72.15 },
};

// ── Board 2.1 ──────────────────────────────────────────────────────────────────────────────────

export const ROB_REPORT: ReportSubjectData = {
  reportId: id<'reports'>('r_black_ice'),
  body: MASCOMA,
  point: { lat: 43.6309, lng: -72.1572 },
  place: 'Enfield, NH',
  skateStartTime: at(10, 10, 15, 40),
  skateEndTime: at(10, 10, 17, 5),
  observedFrom: 'on_ice',
  notes:
    'Black ice over most of the north end, 3½" where I drilled off the town beach and it held fine. Glass until the wind picked up around 3. South end past the island still open.',
  claims: {
    iceThickness: { readings: [{ valueCm: cm(3.5), method: 'measured' }] },
    iceTypes: [{ type: 'black_ice' }],
    surfaceTags: [{ type: 'glass' }],
    sightings: [{ type: 'open', where: { sector: 'S' } }],
    suitability: 'experienced_only',
    skateQuality: 'good',
    snow: null,
  },
  photoCount: 0,
  moderationStatus: 'visible',
  ratings: { up: 0, down: 2 },
  // 2.1's *Corrob.*: one report agreed with it (Kate Donovan, from shore).
  corroborations: { count: 1, capped: false },
};

export const SARAH_FLAG: FlagMember = {
  flagId: id<'contentFlags'>('f_sarah'),
  reason: 'unsafe_false_report',
  note: 'He was on about 2 inches. I measured 1¾ at the beach an hour later and it was cracking under the kids.',
  filedAt: at(10, 10, 18, 2),
  status: 'open',
  filer: SARAH,
  autoFiled: false,
  occurrences: 1,
  lastOccurrenceAt: null,
  prior: null,
};

export const ROB_AUTHOR: AuthorBlockData = {
  person: ROB,
  standing: { status: 'suspended', until: at(10, 15, 12), by: ref(MATT) },
  reports: { count: 14, capped: false },
  contradicted: { count: 2, capped: false },
  contradictedReports: [],
  // 2.1: "the first was actioned Saturday".
  priorActioned: { count: 1, capped: false, lastAt: at(10, 10, 12) },
  openFlags: { count: 1, capped: false },
  restrictions: [],
};

const base = {
  itemId: id<'inboxItems'>('i_safety'),
  facet: 'reports',
  memberCount: 1,
  memberCountIsFloor: false,
  // The read cut no flag short of the count (`flagsCut`).
  flagsCut: false,
  // No flag verb's refusal has a code (the server codes only a place ask's waiting Approve).
  canCode: {},
  decided: null,
};

/** Every flag verb allowed. */
export const CAN_ALL = {
  dismiss: null,
  hide: null,
  remove: null,
  restore: null,
  pin: null,
  unpin: null,
  retract: null,
} as const;

/** Board 2.1: Sarah's unsafe flag on Rob's black-ice report. */
export const SAFETY_ITEM: FlagItem = {
  ...base,
  kind: 'flag',
  lane: 'safety',
  filedAt: SARAH_FLAG.filedAt,
  lastActivityAt: SARAH_FLAG.filedAt,
  can: { dismiss: null, hide: null, remove: null },
  target: {
    targetType: 'report',
    targetId: ROB_REPORT.reportId,
    exists: true,
    withdrawnAt: null,
    withdrawal: null,
    summary: 'Black ice, 3½" at the beach, held fine',
    moderationStatus: 'visible',
    report: ROB_REPORT,
  },
  flags: [SARAH_FLAG],
  author: ROB_AUTHOR,
};

export const WEATHER: ClaimWeatherData = {
  dayMs: Date.UTC(2026, 9, 9),
  lowC: -4.4,
  freezingNights: { run: 2, gapAfter: false },
  freezingDegreeDaysC: { value: 17.2, since: Date.UTC(2026, 9, 1), days: 9 },
  stefan: { thicknessIn: 1.1, freezingDegreeDays: 17.2, alpha: 0.7, windowDays: 60 },
};

/** A body with no weather rows at all: what `claimWeather` answers for it. */
export const WEATHER_NONE: ClaimWeatherData = {
  dayMs: Date.UTC(2026, 9, 9),
  lowC: null,
  freezingNights: { run: 0, gapAfter: true },
  freezingDegreeDaysC: { value: 0, since: Date.UTC(2026, 9, 1), days: 0 },
  stefan: { declined: 'no_weather' },
};

/** Inputs missing: the low not observed, the estimate declined. */
export const WEATHER_GAPS: ClaimWeatherData = {
  ...WEATHER,
  lowC: null,
  freezingNights: { run: 1, gapAfter: true },
  stefan: { declined: 'too_little_cold' },
};

const around = (
  key: string,
  author: PersonLockupData,
  start: number | null,
  end: number,
  over: Partial<AroundReportData>,
): AroundReportData => ({
  reportId: id<'reports'>(`r_${key}`),
  skateStartTime: start,
  skateEndTime: end,
  observedFrom: 'on_ice',
  author: ref(author),
  authorReports: author.points > 50 ? null : Math.max(2, Math.round(author.points / 3)),
  notes: null,
  claims: {
    iceThickness: null,
    iceTypes: [],
    surfaceTags: [],
    sightings: [],
    suitability: null,
    skateQuality: null,
    snow: null,
  },
  distanceMeters: 1000,
  placeName: null,
  moderationStatus: 'visible',
  ...over,
});

export const AROUND_ROB: AroundReportData = around(
  'black_ice',
  ROB,
  ROB_REPORT.skateStartTime,
  ROB_REPORT.skateEndTime,
  {
    authorReports: 14,
    notes: ROB_REPORT.notes,
    claims: ROB_REPORT.claims,
    distanceMeters: 0,
    placeName: 'Town beach',
  },
);

const DANA_R = around('dana', DANA, null, at(10, 11, 8, 40), {
  observedFrom: 'shore',
  authorReports: 2,
  notes: 'Gray and wet along the north shore after the rain. Looked thin, didn’t go out.',
  claims: {
    ...AROUND_ROB.claims,
    iceThickness: null,
    iceTypes: [],
    surfaceTags: [{ type: 'wet' }],
    sightings: [],
    suitability: null,
    skateQuality: null,
  },
  distanceMeters: 1290,
  placeName: 'North launch',
});
const SARAH_R = around('sarah', SARAH, null, at(10, 10, 17, 55), {
  notes:
    '1¾" at the edge of the beach, cracking under a couple of kids. Nobody should be past the swim line.',
  claims: {
    ...AROUND_ROB.claims,
    iceThickness: { readings: [{ valueCm: cm(1.75), method: 'measured' }] },
    iceTypes: [],
    surfaceTags: [{ type: 'cracked_surface' }],
    sightings: [],
    suitability: 'dont_go',
    skateQuality: null,
  },
  distanceMeters: 160,
  placeName: 'Town beach',
});
const LUC_R = around('luc', LUC, null, at(10, 8, 16, 20), {
  observedFrom: 'shore',
  authorReports: 9,
  notes: 'Skim ice in the coves, open water down the middle. Nobody out.',
  claims: {
    ...AROUND_ROB.claims,
    iceThickness: null,
    iceTypes: [],
    surfaceTags: [],
    sightings: [{ type: 'skim' }, { type: 'open', where: { sector: 'middle' } }],
    suitability: null,
    skateQuality: null,
  },
  distanceMeters: 1930,
  placeName: 'Shaker cove',
});

/** Board 2.1's line and drawer: three more reports within three days. */
export const AROUND: AroundItData = {
  flagged: AROUND_ROB,
  reports: [LUC_R, SARAH_R, DANA_R],
  window: { from: at(10, 7, 12), to: at(10, 13, 12), days: 3 },
  cappedBefore: false,
  cappedAfter: false,
  phrases: [
    { key: 'measured_less', count: 1 },
    { key: 'open_water', count: 1 },
    { key: 'skim_ice', count: 1 },
    { key: 'dont_go', count: 1 },
    { key: 'wet_or_slushy', count: 1 },
  ],
};

/** No other report in the window. */
export const AROUND_EMPTY: AroundItData = { ...AROUND, reports: [], phrases: [] };

/** Only reports before the flagged one (one-sided), one of them hidden. */
export const AROUND_ONE_SIDED: AroundItData = {
  ...AROUND,
  reports: [LUC_R, { ...SARAH_R, moderationStatus: 'hidden' }],
  phrases: [
    { key: 'measured_less', count: 1 },
    { key: 'open_water', count: 1 },
  ],
};

/** The read cut the window short on both sides. */
export const AROUND_CAPPED: AroundItData = { ...AROUND, cappedBefore: true, cappedAfter: true };

// ── Board 2.6 ──────────────────────────────────────────────────────────────────────────────────

export const MOREY_ALERT: AlertSubjectData = {
  accessAlertId: id<'accessAlerts'>('aa_fairlee'),
  body: MOREY,
  place: {
    name: 'Fairlee town launch',
    point: { lat: 43.91, lng: -72.14 },
    targetType: 'putIn' as never,
  },
  reason: 'road_closed',
  kind: 'blocker',
  note: 'Town lot closed for paving, use the Bonnie Oaks pull-off.',
  status: 'official',
  createdAt: at(10, 2, 9),
  expiresAt: at(11, 8, 9),
  pinnedBy: ref(TEAGAN),
  confirmCount: 1,
  denyCount: 0,
  lastConfirmedAt: at(10, 9, 10),
  life: [
    { at: at(10, 2, 9), event: 'posted', by: ref(JAMIE) },
    { at: at(10, 3, 10), event: 'pinned', by: ref(TEAGAN) },
    { at: at(10, 9, 10), event: 'confirmed', by: ref(LUC) },
    { at: at(10, 14, 8, 52), event: 'flagged', by: ref(KATE) },
  ],
};

export const KATE_FLAG: FlagMember = {
  flagId: id<'contentFlags'>('f_kate'),
  reason: 'other',
  note: 'Paving’s done, the lot reopened yesterday. I parked there this morning.',
  filedAt: at(10, 14, 6),
  status: 'open',
  filer: KATE,
  autoFiled: false,
  occurrences: 1,
  lastOccurrenceAt: null,
  prior: null,
};

/** Board 2.6: Kate's flag on Jamie's pinned Fairlee alert. */
export const ALERT_ITEM: FlagItem = {
  ...base,
  itemId: id<'inboxItems'>('i_alert'),
  facet: 'alerts',
  kind: 'flag',
  lane: 'contentFlags',
  filedAt: KATE_FLAG.filedAt,
  lastActivityAt: KATE_FLAG.filedAt,
  can: { dismiss: null, pin: 'This alert is already pinned.', unpin: null, retract: null },
  target: {
    targetType: 'accessAlert',
    targetId: MOREY_ALERT.accessAlertId,
    exists: true,
    withdrawnAt: null,
    withdrawal: null,
    summary: 'Fairlee launch closed',
    moderationStatus: null,
    alert: MOREY_ALERT,
  },
  flags: [KATE_FLAG],
  author: {
    person: JAMIE,
    standing: { status: 'active', until: null, by: null },
    reports: { count: 31, capped: false },
    contradicted: { count: 0, capped: false },
    contradictedReports: [],
    priorActioned: { count: 0, capped: false, lastAt: null },
    openFlags: { count: 1, capped: false },
    restrictions: [],
  },
};

// ── The undrawn states ─────────────────────────────────────────────────────────────────────────

/** Two people flagged the same report (one with no words). */
export const SAFETY_MANY: FlagItem = {
  ...SAFETY_ITEM,
  memberCount: 2,
  memberCountIsFloor: false,
  flags: [
    SARAH_FLAG,
    {
      ...SARAH_FLAG,
      flagId: id<'contentFlags'>('f_kate_safety'),
      note: null,
      filedAt: at(10, 11, 7, 30),
      filer: KATE,
    },
  ],
  author: { ...ROB_AUTHOR, openFlags: { count: 2, capped: false } },
};

/** A content flag on a Post of two reports, spam and harassment both filed. */
export const POST_ITEM: FlagItem = {
  ...base,
  itemId: id<'inboxItems'>('i_post'),
  facet: 'reports',
  kind: 'flag',
  lane: 'contentFlags',
  memberCount: 2,
  memberCountIsFloor: false,
  filedAt: at(10, 13, 9),
  lastActivityAt: at(10, 13, 20),
  can: { dismiss: null, hide: null, remove: null },
  target: {
    targetType: 'post',
    targetId: 'post_morning',
    exists: true,
    withdrawnAt: null,
    withdrawal: null,
    summary: 'Morning loop, both ends',
    moderationStatus: 'visible',
    post: {
      postId: id<'posts'>('post_morning'),
      title: 'Morning loop, both ends',
      body: 'Join the club skate Saturday — link in my profile, discount code ICE.',
      reports: [ROB_REPORT, { ...ROB_REPORT, reportId: id<'reports'>('r_second'), notes: null }],
    },
  },
  flags: [
    {
      ...KATE_FLAG,
      flagId: id<'contentFlags'>('f_spam'),
      reason: 'spam',
      note: 'Selling memberships in a report.',
      filedAt: at(10, 13, 9),
    },
    {
      ...SARAH_FLAG,
      flagId: id<'contentFlags'>('f_har'),
      reason: 'harassment',
      note: 'The second report names a kid.',
      filedAt: at(10, 13, 20),
    },
  ],
  author: { ...ROB_AUTHOR, standing: { status: 'active', until: null, by: null } },
};

/** A comment flagged as harassment, on a report's thread. */
export const COMMENT_ITEM: FlagItem = {
  ...base,
  itemId: id<'inboxItems'>('i_comment'),
  facet: 'comments',
  kind: 'flag',
  lane: 'contentFlags',
  filedAt: at(10, 13, 16),
  lastActivityAt: at(10, 13, 16),
  can: { dismiss: null, hide: null, remove: null },
  target: {
    targetType: 'comment',
    targetId: 'c_thermo',
    exists: true,
    withdrawnAt: null,
    withdrawal: null,
    summary: 'Learn to read a thermometer.',
    moderationStatus: 'visible',
    comment: {
      commentId: id<'comments'>('c_thermo'),
      body: 'Learn to read a thermometer.',
      createdAt: at(10, 13, 15, 40),
      on: {
        reportId: ROB_REPORT.reportId,
        postId: null,
        head: 'Rob Tremblay’s report · Mascoma Lake · 10 Oct',
      },
    },
  },
  flags: [
    {
      ...SARAH_FLAG,
      flagId: id<'contentFlags'>('f_c'),
      reason: 'harassment',
      note: 'Third one this week aimed at Sarah.',
      filedAt: at(10, 13, 16),
    },
  ],
  author: {
    ...ROB_AUTHOR,
    person: DANA,
    standing: { status: 'active', until: null, by: null },
    restrictions: ['comments'],
  },
};

/** The hazard vote's "never existed", filed by the app, its fourth occurrence. */
export const HAZARD_AUTO_ITEM: FlagItem = {
  ...base,
  itemId: id<'inboxItems'>('i_hazard'),
  facet: 'hazards',
  kind: 'flag',
  lane: 'safety',
  filedAt: at(10, 12, 7),
  lastActivityAt: at(10, 14, 9),
  can: { dismiss: null, hide: null, remove: null },
  target: {
    targetType: 'hazard',
    targetId: 'h_hole',
    exists: true,
    withdrawnAt: null,
    withdrawal: null,
    summary: 'Open hole by the boat launch',
    moderationStatus: 'visible',
    hazard: {
      hazardId: id<'hazards'>('h_hole'),
      body: MASCOMA,
      type: 'open_water' as never,
      note: 'Open hole by the boat launch, about 3 m across.',
      point: { lat: 43.632, lng: -72.16 },
      createdAt: at(10, 6, 10),
      votes: { still_there: 1, healing_unsafe: 0, fully_healed: 0, never_existed: 2 },
      votesCapped: false,
    },
  },
  flags: [
    {
      ...SARAH_FLAG,
      flagId: id<'contentFlags'>('f_auto'),
      // The hazard vote's note as production writes it (`hazardConfirmations`): the rule's own count.
      note: '2 skaters reported that nothing was ever at this pin.',
      filer: null,
      autoFiled: true,
      occurrences: 4,
      lastOccurrenceAt: at(10, 14, 9),
      prior: { resolvedAt: at(10, 8, 12), resolution: 'dismissed' },
      filedAt: at(10, 12, 7),
    },
  ],
  author: { ...ROB_AUTHOR, person: LUC, standing: { status: 'active', until: null, by: null } },
};

/** The contradiction check against a person (an app flag on a user). */
/** What production writes on every contradiction-check flag (`contradictions.ts`). */
export const CONTRADICTION_NOTE =
  'Auto: repeated weather-unexplained contradictions against corroborated reports. Review the good-vs-bad trend.';

/** The contradiction check's subject: the reports the rule counted, his reports past the cap. */
export const CONTRADICTED_AUTHOR: AuthorBlockData = {
  ...ROB_AUTHOR,
  reports: { count: 100, capped: true },
  contradicted: { count: 3, capped: false },
  contradictedReports: [
    {
      reportId: id<'reports'>('r_black_ice'),
      skateEndTime: at(10, 10, 17, 5),
      author: ref(ROB),
      observedFrom: 'on_ice',
    },
    {
      reportId: id<'reports'>('r_four_inches'),
      skateEndTime: at(10, 7, 16),
      author: ref(ROB),
      observedFrom: 'on_ice',
    },
    {
      reportId: id<'reports'>('r_glass'),
      skateEndTime: at(10, 3, 11, 30),
      author: ref(ROB),
      observedFrom: 'shore',
    },
  ],
  priorActioned: { count: 50, capped: true, lastAt: at(10, 10, 12) },
};

export const PERSON_ITEM: FlagItem = {
  ...base,
  itemId: id<'inboxItems'>('i_person'),
  facet: 'people',
  kind: 'flag',
  lane: 'safety',
  filedAt: at(10, 13, 3),
  lastActivityAt: at(10, 13, 3),
  can: { dismiss: null },
  target: {
    targetType: 'user',
    targetId: ROB.userId,
    exists: true,
    withdrawnAt: null,
    withdrawal: null,
    summary: 'Rob Tremblay',
    moderationStatus: null,
    person: CONTRADICTED_AUTHOR,
  },
  flags: [
    {
      ...HAZARD_AUTO_ITEM.flags[0],
      flagId: id<'contentFlags'>('f_contra'),
      // The contradiction check's note as production writes it (`contradictions.ts`): fixed prose.
      note: CONTRADICTION_NOTE,
      occurrences: 2,
      prior: null,
    } as FlagMember,
  ],
  author: ROB_AUTHOR,
};

/** Hidden elsewhere before this flag was read: Restore is what's offered. */
export const DOWN_ITEM: FlagItem = {
  ...COMMENT_ITEM,
  itemId: id<'inboxItems'>('i_down'),
  can: { dismiss: null, restore: null },
  target: {
    ...(COMMENT_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    moderationStatus: 'hidden',
  },
};

/** Its author deleted it; the flag still waits. */
export const GONE_ITEM: FlagItem = {
  ...COMMENT_ITEM,
  itemId: id<'inboxItems'>('i_gone'),
  can: { dismiss: null },
  target: { targetType: 'comment', targetId: 'c_gone', exists: false },
};

/** A viewer whose `can` refuses every verb: no bar. */
export const REFUSED_ITEM: FlagItem = {
  ...SAFETY_ITEM,
  can: {
    dismiss: 'You filed this, so another staff member decides it',
    hide: 'You filed this, so another staff member decides it',
    remove: 'You filed this, so another staff member decides it',
  },
};

/**
 * The viewer filed an open flag on this content in another lane (D289): a takedown would close it, so
 * Hide and Remove are refused with the own-filing sentence; this item's own flags aren't theirs, so
 * Dismiss stands — the bar draws Dismiss only.
 */
export const OWN_FILING_ELSEWHERE_ITEM: FlagItem = {
  ...SAFETY_ITEM,
  can: {
    dismiss: null,
    hide: 'You filed this, so another staff member decides it.',
    remove: 'You filed this, so another staff member decides it.',
  },
};

/** The viewer's own content (D269): every verb refused, no bar. */
export const OWN_ITEM: FlagItem = {
  ...ALERT_ITEM,
  can: {
    dismiss: 'This is your own alert, so another staff member decides it',
    unpin: 'This is your own alert, so another staff member decides it',
    retract: 'This is your own alert, so another staff member decides it',
  },
};

/** Decided by a colleague while it was open. */
export const DECIDED_ITEM: FlagItem = {
  ...SAFETY_ITEM,
  decided: {
    at: at(10, 14, 11, 42),
    by: { userId: MATT.userId, displayName: MATT.displayName },
    decision: 'actioned',
    actionId: id<'moderationActions'>('a_matt'),
    byMe: false,
  },
};

/** A write that lands, undoable with a reason (a takedown's). */
export const LANDED: InboxWriteResultData = {
  itemId: SAFETY_ITEM.itemId,
  actionId: id<'moderationActions'>('a_new'),
  flagsClosed: 1,
  undoable: true,
  undoNeedsReason: false,
};

// ── Withdrawn, and words a viewer may not read ─────────────────────────────────────────────────

/** Rob deleted the flagged report himself before anyone decided the flag. */
export const WITHDRAWN_REPORT_ITEM: FlagItem = {
  ...SAFETY_ITEM,
  itemId: id<'inboxItems'>('i_withdrawn'),
  can: { dismiss: null, hide: null, remove: null },
  target: {
    ...(SAFETY_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    withdrawnAt: at(10, 12, 9, 15),
    withdrawal: 'deleted',
  } as FlagItem['target'],
};

/** A comment erased past its 30 days, its flag still open. */
export const ERASED_COMMENT_ITEM: FlagItem = {
  ...COMMENT_ITEM,
  itemId: id<'inboxItems'>('i_erased'),
  can: { dismiss: null, hide: null, remove: null },
  target: {
    ...(COMMENT_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    withdrawnAt: at(10, 13, 22),
    withdrawal: 'erased',
    summary: '',
    comment: {
      ...(COMMENT_ITEM.target.exists && COMMENT_ITEM.target.targetType === 'comment'
        ? COMMENT_ITEM.target.comment
        : (undefined as never)),
      body: '',
    },
  } as FlagItem['target'],
};

/** Jamie retracted the alert after Kate flagged it. */
export const RETRACTED_ALERT_ITEM: FlagItem = {
  ...ALERT_ITEM,
  itemId: id<'inboxItems'>('i_retracted'),
  can: {
    dismiss: null,
    pin: 'This alert has been retracted, so it can’t be pinned.',
    unpin: 'This alert isn’t pinned.',
    retract: 'Its author already took this alert down.',
  },
  target: {
    ...(ALERT_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    alert: {
      ...MOREY_ALERT,
      status: 'retracted',
      life: [...MOREY_ALERT.life, { at: at(10, 14, 10, 30), event: 'retracted', by: ref(JAMIE) }],
    },
  } as FlagItem['target'],
};

/** A hidden comment read by a viewer without `content.read`: its words aren't served. */
export const UNREADABLE_ITEM: FlagItem = {
  ...COMMENT_ITEM,
  itemId: id<'inboxItems'>('i_unreadable'),
  can: { dismiss: null, restore: null },
  target: {
    ...(COMMENT_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    moderationStatus: 'hidden',
    summary: '',
    comment: {
      ...(COMMENT_ITEM.target.exists && COMMENT_ITEM.target.targetType === 'comment'
        ? COMMENT_ITEM.target.comment
        : (undefined as never)),
      body: '',
    },
  } as FlagItem['target'],
};

/** A takedown that closed this item's flag and two in another lane. */
export const LANDED_ACROSS_LANES: InboxWriteResultData = { ...LANDED, flagsClosed: 3 };

/**
 * Three members, one closed by an earlier decision: two flags are this item's question. The item's
 * count is the server's (`deriveItem`): its open members while any is open — two.
 */
export const SAFETY_WITH_CLOSED: FlagItem = {
  ...SAFETY_MANY,
  itemId: id<'inboxItems'>('i_closed_member'),
  memberCount: 2,
  memberCountIsFloor: false,
  flags: [
    ...SAFETY_MANY.flags,
    {
      ...SARAH_FLAG,
      flagId: id<'contentFlags'>('f_closed'),
      reason: 'spam',
      note: 'Closed long ago.',
      filedAt: at(10, 9, 9),
      status: 'closed',
      filer: LUC,
    },
  ],
};

/** Kate's flag on an alert that isn't pinned: Pin is offered, Unpin isn't. */
export const UNPINNED_ALERT_ITEM: FlagItem = {
  ...ALERT_ITEM,
  itemId: id<'inboxItems'>('i_unpinned'),
  can: { dismiss: null, pin: null, unpin: 'This alert isn’t pinned.', retract: null },
  target: {
    ...(ALERT_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    alert: {
      ...MOREY_ALERT,
      status: 'active',
      pinnedBy: null,
      life: MOREY_ALERT.life.filter((e) => e.event !== 'pinned'),
    },
  } as FlagItem['target'],
};

// ── A hazard's votes ───────────────────────────────────────────────────────────────────────────

/** Every verdict at a different count, so a swapped label shows. */
export const DISTINCT_VOTES = {
  still_there: 1,
  healing_unsafe: 2,
  fully_healed: 3,
  never_existed: 4,
};

/** The hazard vote's flag on a ridge crossing: core relabels every verdict for a passage marker. */
export const RIDGE_AUTO_ITEM: FlagItem = {
  ...HAZARD_AUTO_ITEM,
  itemId: id<'inboxItems'>('i_ridge'),
  target: {
    ...(HAZARD_AUTO_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    hazard: {
      ...(HAZARD_AUTO_ITEM.target.exists && HAZARD_AUTO_ITEM.target.targetType === 'hazard'
        ? HAZARD_AUTO_ITEM.target.hazard
        : (undefined as never)),
      type: 'ridge_crossing',
      note: 'Low spot in the ridge off the point.',
      votes: DISTINCT_VOTES,
    },
  } as FlagItem['target'],
};

/** A flagged hazard no one has voted on. */
export const UNVOTED_HAZARD_ITEM: FlagItem = {
  ...RIDGE_AUTO_ITEM,
  itemId: id<'inboxItems'>('i_unvoted'),
  target: {
    ...(RIDGE_AUTO_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    hazard: {
      ...(RIDGE_AUTO_ITEM.target.exists && RIDGE_AUTO_ITEM.target.targetType === 'hazard'
        ? RIDGE_AUTO_ITEM.target.hazard
        : (undefined as never)),
      type: 'open_water',
      votes: { still_there: 0, healing_unsafe: 0, fully_healed: 0, never_existed: 0 },
    },
  } as FlagItem['target'],
};

/** More votes than the read counts: every figure a floor. */
export const CAPPED_VOTES_ITEM: FlagItem = {
  ...UNVOTED_HAZARD_ITEM,
  itemId: id<'inboxItems'>('i_capped_votes'),
  target: {
    ...(UNVOTED_HAZARD_ITEM.target as Extract<FlagItem['target'], { exists: true }>),
    hazard: {
      ...(UNVOTED_HAZARD_ITEM.target.exists && UNVOTED_HAZARD_ITEM.target.targetType === 'hazard'
        ? UNVOTED_HAZARD_ITEM.target.hazard
        : (undefined as never)),
      votes: { still_there: 120, healing_unsafe: 0, fully_healed: 30, never_existed: 50 },
      votesCapped: true,
    },
  } as FlagItem['target'],
};
