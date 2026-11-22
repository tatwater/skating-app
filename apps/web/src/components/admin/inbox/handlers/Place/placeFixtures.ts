import { zonedInstant } from '@skating/core';

import { KATE, LUC, MASCOMA, NEWFOUND, NOW, PLACE_ITEM } from '../../list/inboxFixtures';
import type { PlaceItem } from './placeModel';

/**
 * **Board 2.4's place asks, as `inbox.item` returns them** — for stories and tests only (the page
 * draws only what a read returned, `fixturesStayInStories.test.ts`). The board's landmark ask on
 * Newfound Lake ("the Narrows", from Luc Pelletier's report) against The Narrows in OpenStreetMap,
 * and the other states a place ask can be in, each with the `can` its viewer would be answered.
 */

export const PLACE_NOW = NOW;
const H = 3_600_000;
const D = 24 * H;
const id = (s: string) => s.padEnd(32, '0') as never;

const lockup = (p: typeof LUC, points = 41) => ({
  ...p,
  role: 'member' as const,
  trustClass: 'trusted' as const,
  points,
});

const OWN = 'You filed this, so another staff member decides it.';
const NO_LANDMARK =
  'No landmark called "the Narrows" near that spot on Newfound Lake yet — add it in the lake editor first, then approve.';
const NO_BAY =
  'No sub-area called "Shaker cove" on Mascoma Lake yet — draw it in the lake editor first, then approve.';

const LUC_ASK = {
  requestId: id('rqnarrows'),
  asker: lockup(LUC, 63),
  askedAt: NOW - 5 * H,
  note: null,
  name: 'the Narrows',
  coord: { lat: 43.6702, lng: -71.7588 },
  status: 'open',
  fromReport: {
    reportId: id('rpluc14oct'),
    // 14 Oct 09:40 in the board's zone.
    skateEndTime: zonedInstant(2026, 10, 14, 9 * 60 + 40, 'America/New_York'),
    where: 'through the Narrows, open water north of it',
  },
  activityId: null,
  skate: null,
  // His landmark asks so far, from his own filings: three asked, two added.
  landmarkAsks: { asked: 3, added: 2, capped: false },
};

const OSM_NARROWS = {
  kind: 'landmark',
  landmarkId: id('lmnarrows'),
  name: 'The Narrows',
  point: { lat: 43.676, lng: -71.7571 },
  meters: 655,
  landmarkKind: 'narrows',
  source: 'osm',
  aliases: [],
  usedByReports: 0,
};

/** 2.4 as the board draws it: a landmark ask from a report's where, a lookalike 0.4 mi off. */
export const NARROWS = {
  ...(PLACE_ITEM as PlaceItem),
  filedAt: NOW - 5 * H,
  lastActivityAt: NOW - 5 * H,
  memberCount: 1,
  body: { ...NEWFOUND, areaSqM: 4_100 * 4046.8564224 },
  asks: [LUC_ASK],
  asksCut: false,
  primaryRequestId: LUC_ASK.requestId,
  drawnSubAreaId: null,
  answeringLandmarkId: null,
  lookalikes: [OSM_NARROWS],
  can: { approve: NO_LANDMARK, sameAs: null, decline: null },
} as unknown as PlaceItem;

/** A landmark ask with nothing like it on the body: draw it, or decline. */
export const LANDMARK_ALONE = {
  ...NARROWS,
  lookalikes: [],
  can: { approve: NO_LANDMARK, decline: null },
} as unknown as PlaceItem;

/** Another open ask nearby by a similar name — no landmark to compare to yet. */
export const LANDMARK_PROPOSAL = {
  ...LANDMARK_ALONE,
  lookalikes: [
    {
      kind: 'proposal',
      requestId: id('rqnarrows2'),
      name: 'The Narrows',
      coord: { lat: 43.671, lng: -71.758 },
      meters: 120,
    },
  ],
} as unknown as PlaceItem;

/** A landmark by the asked name already stands there: Approve answers it. */
export const LANDMARK_ANSWERED = {
  ...NARROWS,
  answeringLandmarkId: id('lmnarrows'),
  lookalikes: [],
  can: { approve: null, decline: null },
} as unknown as PlaceItem;

const BAY_ASKS = [
  {
    ...LUC_ASK,
    requestId: id('rqbay1'),
    name: 'Shaker cove',
    askedAt: NOW - 6 * H,
    note: 'The cove by the Shaker village, everyone calls it that.',
    coord: { lat: 43.64, lng: -72.17 },
    fromReport: null,
    landmarkAsks: null,
  },
  {
    ...LUC_ASK,
    requestId: id('rqbay2'),
    asker: lockup(KATE),
    name: 'Shaker Cove',
    askedAt: NOW - 1 * D,
    note: null,
    coord: { lat: 43.641, lng: -72.171 },
    fromReport: null,
    landmarkAsks: null,
  },
  {
    ...LUC_ASK,
    requestId: id('rqbay3'),
    asker: null,
    name: 'shaker cove',
    askedAt: NOW - 2 * D,
    note: null,
    coord: { lat: 43.642, lng: -72.17 },
    fromReport: null,
    landmarkAsks: null,
  },
];

/** A bay ask, three askers, no bay by that name drawn yet: Draw in Body, or decline. */
export const BAY_UNDRAWN = {
  ...(PLACE_ITEM as PlaceItem),
  facet: 'bays',
  placeKind: 'name_bay',
  filedAt: NOW - 6 * H,
  lastActivityAt: NOW - 6 * H,
  memberCount: 3,
  body: MASCOMA,
  asks: BAY_ASKS,
  asksCut: false,
  // Served newest first: the newest open ask is the one a decision is sent for.
  primaryRequestId: id('rqbay1'),
  drawnSubAreaId: null,
  answeringLandmarkId: null,
  lookalikes: [],
  can: { approve: NO_BAY, decline: null },
} as unknown as PlaceItem;

/** The bay is drawn now: Approve answers every ask. */
export const BAY_DRAWN = {
  ...BAY_UNDRAWN,
  drawnSubAreaId: id('sashaker'),
  can: { approve: null, decline: null },
} as unknown as PlaceItem;

/** The viewer asked it (D289): every verb refused, so no bar — and the refusal said once. */
export const PLACE_BY_VIEWER = {
  ...NARROWS,
  can: { approve: OWN, sameAs: OWN, decline: OWN },
} as unknown as PlaceItem;

/** Decided by a colleague: the lock. */
export const PLACE_DECIDED = {
  ...NARROWS,
  can: {
    approve: 'This has already been decided.',
    sameAs: 'This has already been decided.',
    decline: 'This has already been decided.',
  },
  decided: {
    at: NOW - 10 * 60_000,
    by: { userId: id('prsarah'), displayName: 'Sarah Berman' },
    decision: 'approved',
    actionId: id('ma7'),
    byMe: false,
  },
} as unknown as PlaceItem;

/** The board's ask from an asker on their first landmark ask. */
export const FIRST_LANDMARK_ASK = {
  ...NARROWS,
  asks: [{ ...LUC_ASK, landmarkAsks: { asked: 1, added: 0, capped: false } }],
} as unknown as PlaceItem;

/** An asker whose filings the server stopped counting: both counts are floors. */
export const MANY_LANDMARK_ASKS = {
  ...NARROWS,
  asks: [{ ...LUC_ASK, landmarkAsks: { asked: 50, added: 31, capped: true } }],
} as unknown as PlaceItem;

/** The asker's history not served (past the item's cap, or the Inbox backfill pending). */
export const UNCOUNTED_ASKER = {
  ...NARROWS,
  asks: [{ ...LUC_ASK, landmarkAsks: null }],
} as unknown as PlaceItem;

/** Every place fixture, by name — the table test walks them all. */
export const PLACE_FIXTURES = {
  NARROWS,
  LANDMARK_ALONE,
  LANDMARK_PROPOSAL,
  LANDMARK_ANSWERED,
  BAY_UNDRAWN,
  BAY_DRAWN,
  PLACE_BY_VIEWER,
  PLACE_DECIDED,
} as const;

/**
 * A landmark several people asked for: three askers, two with a landmark history the read serves
 * (the first few askers' counts) and one whose profile is gone — the list says each history, under
 * its own asker, and nothing for the departed one.
 */
export const LANDMARK_SEVERAL = {
  ...NARROWS,
  memberCount: 3,
  asks: [
    LUC_ASK,
    {
      ...LUC_ASK,
      requestId: id('rqnarrows-kate'),
      asker: lockup(KATE),
      askedAt: NOW - 1 * D,
      fromReport: null,
      landmarkAsks: { asked: 1, added: 0, capped: false },
    },
    {
      ...LUC_ASK,
      requestId: id('rqnarrows-gone'),
      asker: null,
      askedAt: NOW - 2 * D,
      fromReport: null,
      landmarkAsks: null,
    },
  ],
} as unknown as PlaceItem;

/**
 * The drawn bay with a newer ask already closed (its asker withdrew it), served first: the ask a
 * decision is sent for (`primaryRequestId`, the newest open one) is not `asks[0]`.
 */
export const BAY_DRAWN_CLOSED_FIRST = {
  ...BAY_DRAWN,
  itemId: id('itbayclosedfirst'),
  asks: [
    { ...BAY_ASKS[0], requestId: id('rqbaywithdrawn'), askedAt: NOW - 1 * H, status: 'closed' },
    ...BAY_ASKS,
  ],
  primaryRequestId: id('rqbay1'),
} as unknown as PlaceItem;

/** One asker, with a note and the recorded skate they asked from: the compact layout says both. */
export const LANDMARK_NOTED = {
  ...NARROWS,
  itemId: id('itnarrowsnoted'),
  asks: [
    {
      ...LUC_ASK,
      note: 'Everyone at the launch calls it the Narrows.',
      activityId: id('acluc14oct'),
      skate: { startTime: NOW - 6 * H, endTime: NOW - 5 * H, elapsedSeconds: 48 * 60 },
    },
  ],
} as unknown as PlaceItem;

/** One ask served of four (the item's budget cut the list): the compact layout says one of four. */
export const LANDMARK_ONE_OF_MANY = {
  ...NARROWS,
  itemId: id('itnarrowsmany'),
  memberCount: 4,
  asksCut: true,
} as unknown as PlaceItem;
