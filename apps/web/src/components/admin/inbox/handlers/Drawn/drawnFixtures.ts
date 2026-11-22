import { zonedInstant } from '@skating/core';

import { CASPIAN, DRAWN_ITEM, KATE, NOW } from '../../list/inboxFixtures';
import type { DrawnItem } from './drawnModel';

/**
 * **Board 2.5's drawn bodies, as `inbox.item` returns them** — for stories and tests only (the page
 * draws only what a read returned, `fixturesStayInStories.test.ts`). The board's drawing over
 * Caspian Lake by Kate Donovan, and the other states a drawn item can be in, each with the `can` its
 * viewer would be answered.
 */

export const DRAWN_NOW = NOW;
const H = 3_600_000;

const OPEN = { approveDrawn: null, mergeDrawn: null, rejectDrawn: null };

/** 2.5 as the board draws it: 92 % of the drawing is Caspian Lake, from a recorded skate. */
export const OVER_CASPIAN = {
  ...(DRAWN_ITEM as DrawnItem),
  filedAt: NOW - 2 * H,
  lastActivityAt: NOW - 2 * H,
  can: OPEN,
  overlap: {
    share: 0.92,
    suggested: true,
    body: { ...CASPIAN, areaSqM: 789 * 4046.8564224 },
  },
  fromReport: {
    reportId: 'rpkate11oct'.padEnd(32, '0'),
    // 11 Oct, late morning in the board's zone.
    skateEndTime: zonedInstant(2026, 10, 11, 11 * 60, 'America/New_York'),
    author: KATE,
    observedFrom: null,
    excerpt: 'Skated the east arm all morning with the club.',
  },
  // The skate the drawing was made from: 11 Oct, two hours out, with a track for the map.
  skate: {
    activityId: 'ackate11oct'.padEnd(32, '0'),
    startTime: zonedInstant(2026, 10, 11, 9 * 60, 'America/New_York'),
    endTime: zonedInstant(2026, 10, 11, 11 * 60, 'America/New_York'),
    elapsedSeconds: 96 * 60,
    hasTrack: true,
  },
  drawerReports: 14,
} as unknown as DrawnItem;

/** A drawing over no known body: nothing to merge into, so no gauge and no merge. */
export const NEW_WATER = {
  ...OVER_CASPIAN,
  can: { approveDrawn: null, rejectDrawn: null },
  overlap: null,
  fromReport: null,
  skate: null,
} as unknown as DrawnItem;

/** Under the threshold: the gauge says so, its label quiet; a merge is still drawn (Coming soon). */
export const BELOW_THRESHOLD = {
  ...OVER_CASPIAN,
  overlap: { ...OVER_CASPIAN.overlap, share: 0.41, suggested: false },
} as unknown as DrawnItem;

/** A moderator without the duplicates capability: approve and reject, no merge drawn. */
export const MODERATOR_VIEW = {
  ...OVER_CASPIAN,
  can: { ...OPEN, mergeDrawn: 'Requires admin role' },
} as unknown as DrawnItem;

/** The viewer drew it (D289): every verb refused, so no bar — and the refusal said once. */
export const DRAWN_BY_VIEWER = {
  ...OVER_CASPIAN,
  can: {
    approveDrawn: 'You filed this, so another staff member decides it.',
    mergeDrawn: 'You filed this, so another staff member decides it.',
    rejectDrawn: 'You filed this, so another staff member decides it.',
  },
} as unknown as DrawnItem;

/** The drawer's account is gone. */
export const DRAWER_GONE = {
  ...OVER_CASPIAN,
  drawer: {
    ...(OVER_CASPIAN.drawer as NonNullable<DrawnItem['drawer']>),
    displayName: 'Deleted user',
    username: '',
    deleted: true,
    trustClass: null,
  },
} as unknown as DrawnItem;

/** Decided by a colleague: no verb (the item's `can` is empty once decided), the lock. */
export const DRAWN_DECIDED = {
  ...OVER_CASPIAN,
  can: {
    approveDrawn: 'This has already been decided.',
    mergeDrawn: 'This has already been decided.',
    rejectDrawn: 'This has already been decided.',
  },
  decided: {
    at: NOW - 10 * 60_000,
    by: { userId: 'prsarah'.padEnd(32, '0'), displayName: 'Sarah Berman' },
    decision: 'approved',
    actionId: 'ma9'.padEnd(32, '0'),
    byMe: false,
  },
} as unknown as DrawnItem;

/** The report is hidden or withdrawn, to this viewer: its words withheld, the rest as served. */
export const REPORT_WITHHELD = {
  ...OVER_CASPIAN,
  fromReport: {
    ...(OVER_CASPIAN.fromReport as NonNullable<DrawnItem['fromReport']>),
    excerpt: null,
  },
} as unknown as DrawnItem;

/** A long report, cut by the server at 100 characters with its own ellipsis. */
export const LONG_REPORT = {
  ...OVER_CASPIAN,
  fromReport: {
    ...(OVER_CASPIAN.fromReport as NonNullable<DrawnItem['fromReport']>),
    excerpt:
      'Skated the whole east shore, tested in four places. The map had no lake here so I drew one a…',
  },
} as unknown as DrawnItem;

/**
 * A skate with no report, whose provider sent no end and no moving time; a drawer whose report
 * count the server couldn't give.
 */
export const BARE_SKATE = {
  ...OVER_CASPIAN,
  fromReport: null,
  skate: {
    ...(OVER_CASPIAN.skate as NonNullable<DrawnItem['skate']>),
    endTime: null,
    elapsedSeconds: null,
    hasTrack: false,
  },
  drawerReports: null,
} as unknown as DrawnItem;

/** Every drawn fixture, by name — the table test walks them all. */
export const DRAWN_FIXTURES = {
  OVER_CASPIAN,
  NEW_WATER,
  BELOW_THRESHOLD,
  MODERATOR_VIEW,
  DRAWN_BY_VIEWER,
  DRAWER_GONE,
  DRAWN_DECIDED,
  REPORT_WITHHELD,
  LONG_REPORT,
  BARE_SKATE,
} as const;
