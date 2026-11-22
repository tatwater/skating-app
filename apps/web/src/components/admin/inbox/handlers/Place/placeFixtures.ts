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
