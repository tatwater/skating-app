import { metricDayRange } from '@skating/core';

import { BOARD_NOW_NH } from '@/test/boardNow';

import type {
  CoverageData,
  DayKey,
  FlagQueueDay,
  KeepingUpData,
  PulseKey,
  PulseSeries,
  ShowingUpData,
  SupportCategory,
} from './metricsModel';

/**
 * Overview › Metrics' fixtures: the 1.4 board's numbers on the pinned clock. The board was drawn
 * on 1–14 Oct 2026; here the same fourteen days end on the boards' "today", Saturday 16 January
 * 2027 (`BOARD_NOW_NH`), so day *i* of the board is day *i* here. Every shape matches the read that
 * will serve it, which matches the rows under it (`metricSnapshots`, `signInDays`, `contentFlags`,
 * `supportTickets`, `reports`). No live clock (the test-clock guard).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const METRICS_NOW = BOARD_NOW_NH;
export const METRICS_ZONE = 'America/New_York';

/** The season window: fourteen UTC metric days ending today, 3–16 Jan 2027. */
export const BOARD_DAYS: DayKey[] = metricDayRange(METRICS_NOW, 14);

/** Hours waiting, and the open flags by lane ([standard, safety]), per day — the board's chart. */
const OLDEST_HOURS = [20, 44, 68, 30, 54, 6, 30, 18, 0, 6, 30, 54, 78, 94];
const OPEN = [
  [1, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [1, 1],
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
  [1, 1],
  [2, 1],
  [2, 1],
  [2, 1],
  [2, 1],
] as const;

const QUEUE: FlagQueueDay[] = OLDEST_HOURS.map((oldestHours, i) => ({
  oldestHours,
  standard: OPEN[i]?.[0] ?? 0,
  safety: OPEN[i]?.[1] ?? 0,
}));

/** Tickets open at any point of each day, by kind: a bug from Thursday, an appeal from Friday. */
const DEPTH: Array<SupportCategory[]> = [
  [],
  [],
  ['bug'],
  [],
  ['account'],
  ['other'],
  ['other'],
  ['bug'],
  ['account'],
  [],
  [],
  ['bug'],
  ['bug', 'account'],
  ['bug', 'account'],
];

const depthOf = (kinds: SupportCategory[]): Partial<Record<SupportCategory, number>> =>
  Object.fromEntries(kinds.map((k) => [k, 1]));

export const BOARD_KEEPING_UP: KeepingUpData = {
  openFlags: { total: 3, safety: 1 },
  // A Mascoma flag filed 3 d 22 h ago.
  oldestOpenFlag: {
    openedAt: METRICS_NOW - (3 * DAY + 22 * HOUR + 10 * MINUTE),
    where: 'Mascoma Lake',
  },
  // Six resolved this week, four inside six hours: the median is under 6 h.
  resolvedWeek: [4, 1, 0, 1, 0, 0, 0, 0],
  resolveSeason: [5, 2, 0, 1, 1, 0, 0, 0],
  queueByDay: QUEUE,
  support: {
    open: 2,
    oldestOpenedAt: METRICS_NOW - (2 * DAY + 3 * HOUR),
    resolveSeason: [2, 2, 1, 0, 0, 0, 0, 0],
    depthByDay: DEPTH.map(depthOf),
  },
};

const series = (daily: number[], over?: number, total?: number): PulseSeries => ({
  daily,
  total: total ?? daily.reduce((sum, n) => sum + n, 0),
  ...(over === undefined ? {} : { over }),
});

export const BOARD_PULSE: Record<PulseKey, PulseSeries | null> = {
  reports: series([1, 0, 2, 1, 0, 2, 3, 1, 0, 2, 1, 0, 1, 0], 11),
  comments: series([0, 1, 3, 2, 0, 4, 2, 3, 1, 2, 4, 1, 0, 0], 9),
  kudos: series([2, 3, 5, 4, 2, 6, 9, 5, 3, 6, 7, 2, 3, 1], 14),
  photos: series([1, 0, 2, 3, 0, 5, 6, 2, 1, 4, 4, 2, 1, 0], 11),
  hazards: series([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0], 2),
  accounts: series([0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
  // People are distinct across the season, not the sum of the days.
  signedIn: series([4, 3, 8, 6, 4, 9, 11, 7, 5, 10, 8, 4, 6, 5], undefined, 24),
  contributors: series([3, 3, 4, 4, 4, 5, 6, 6, 6, 6, 5, 6, 6, 6], undefined, 11),
};

/** 10 AM in New Hampshire on a board day. */
const morningOf = (i: number) => Date.parse(`${BOARD_DAYS[i]}T15:00:00.000Z`);

export const BOARD_SHOWING_UP: ShowingUpData = {
  week: {
    reports: { count: 5, people: 4 },
    accounts: { added: 2, total: 38 },
    signedIn: { people: 11, twoDaysOrMore: 7 },
    contributors: { people: 6, firstTime: 2 },
  },
  pulse: BOARD_PULSE,
  vantage: { on_ice: 2, shore: 11, secondhand: 1, unstated: 0 },
  mostReported: [
    {
      bodyId: 'mascoma',
      name: 'Mascoma Lake',
      reports: 7,
      photos: 12,
      people: 4,
      lastReportAt: morningOf(10),
    },
    {
      bodyId: 'crystal',
      name: 'Crystal Lake',
      reports: 3,
      photos: 9,
      people: 2,
      lastReportAt: morningOf(12),
    },
    {
      bodyId: 'morey',
      name: 'Lake Morey',
      reports: 2,
      photos: 6,
      people: 2,
      lastReportAt: morningOf(7),
    },
    {
      bodyId: 'sunapee',
      name: 'Lake Sunapee',
      reports: 1,
      photos: 3,
      people: 1,
      lastReportAt: morningOf(3),
    },
    {
      bodyId: 'kezar',
      name: 'Kezar Lake',
      reports: 1,
      photos: 1,
      people: 1,
      lastReportAt: morningOf(5),
    },
  ],
};

export const BOARD_COVERAGE: CoverageData = {
  listedBodies: 24_953,
  states: [
    { state: 'VT', bodies: 8214, reports: 4, comments: 6, photos: 9, kudos: 16, contributors: 4 },
    { state: 'NH', bodies: 6120, reports: 9, comments: 15, photos: 20, kudos: 38, contributors: 7 },
    { state: 'ME', bodies: 5140, reports: 1, comments: 2, photos: 2, kudos: 4, contributors: 1 },
    { state: 'NY', bodies: 3900, reports: 0, comments: 0, photos: 0, kudos: 0, contributors: 0 },
    { state: 'MA', bodies: 1579, reports: 0, comments: 0, photos: 0, kudos: 0, contributors: 0 },
  ],
};

// ── What is recorded today ───────────────────────────────────────────────────────────────────

/** The day the two forward-only records began (B01-1 shipped) — the ninth board day here. */
export const RECORD_BEGAN = 8;

const fromRecord = <T>(values: readonly T[]): Array<T | null> =>
  values.map((v, i) => (i < RECORD_BEGAN ? null : v));

/**
 * The board as the writes stand today: kudos has no record at all, the per-state widening (comments,
 * photos, kudos, contributors by state) is deferred, and the sign-in record and the support queue's
 * depth begin partway through the window — so the week's sign-ins aren't a full week yet.
 */
export const RECORDED_KEEPING_UP: KeepingUpData = {
  ...BOARD_KEEPING_UP,
  support:
    BOARD_KEEPING_UP.support === null
      ? null
      : {
          ...BOARD_KEEPING_UP.support,
          depthByDay: fromRecord(BOARD_KEEPING_UP.support.depthByDay),
        },
};

export const RECORDED_SHOWING_UP: ShowingUpData = {
  ...BOARD_SHOWING_UP,
  week: { ...BOARD_SHOWING_UP.week, signedIn: null },
  pulse: {
    ...BOARD_PULSE,
    kudos: null,
    signedIn: BOARD_PULSE.signedIn && {
      ...BOARD_PULSE.signedIn,
      daily: fromRecord(BOARD_PULSE.signedIn.daily),
      total: 19,
    },
  },
};

export const RECORDED_COVERAGE: CoverageData = {
  ...BOARD_COVERAGE,
  states: BOARD_COVERAGE.states.map((s) => ({
    ...s,
    comments: null,
    photos: null,
    kudos: null,
    contributors: null,
  })),
};

// ── Nothing yet ──────────────────────────────────────────────────────────────────────────────

const zeros = (n: number) => new Array<number>(n).fill(0);

/** A quiet first week: nothing open, nothing resolved, nobody posting. Measured zeros, not gaps. */
export const QUIET_KEEPING_UP: KeepingUpData = {
  openFlags: { total: 0, safety: 0 },
  oldestOpenFlag: null,
  resolvedWeek: zeros(8),
  resolveSeason: zeros(8),
  queueByDay: BOARD_DAYS.map(() => ({ oldestHours: 0, standard: 0, safety: 0 })),
  support: {
    open: 0,
    oldestOpenedAt: null,
    resolveSeason: zeros(8),
    depthByDay: BOARD_DAYS.map(() => ({})),
  },
};

export const QUIET_SHOWING_UP: ShowingUpData = {
  week: {
    reports: { count: 0, people: 0 },
    accounts: { added: 0, total: 3 },
    signedIn: { people: 2, twoDaysOrMore: 0 },
    contributors: { people: 0, firstTime: 0 },
  },
  pulse: {
    reports: series(zeros(14), 0),
    comments: series(zeros(14), 0),
    kudos: null,
    photos: series(zeros(14), 0),
    hazards: series(zeros(14), 0),
    accounts: series(zeros(14)),
    signedIn: series([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2], undefined, 2),
    contributors: series(zeros(14)),
  },
  vantage: { on_ice: 0, shore: 0, secondhand: 0, unstated: 0 },
  mostReported: [],
};
