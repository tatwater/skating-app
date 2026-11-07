import type { FeedCardData, PostCardData } from '@skating/core';

import type { BountyPanelData } from './BountyPanelView';
import type { HazardPanelData } from './HazardPanelView';
import type { ReportPanelData } from './ReportPanelView';

/**
 * The boards' row 2, as data (stories and tests; nothing in the app imports it). People, reports
 * and the hazard are invented; "today" is Saturday 16 January 2027, as on the boards.
 */
export const BOARD_NOW = new Date(2027, 0, 16, 12, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2027, 0, day, h, m).getTime();

/** 2.1: the lead at the Narrows — fresh, confirmed twice. */
export const HAZARD_LEAD: HazardPanelData = {
  hazardId: 'h1',
  type: 'open_water',
  title: 'Open water / lead',
  bodyId: 'w1',
  bodyName: 'Mascoma Lake',
  subAreaName: 'Mascoma North',
  freshnessLabel: 'Recently reported',
  fresh: true,
  badges: [],
  reporter: { displayName: 'Sarah Berman', username: 'sberman' },
  byline: 'Reported Thursday by Sarah Berman · confirmed by Rob Tremblay and Pat Lacasse',
  notes: [],
  description:
    'Open lead from the bridge pilings into the north basin, 20 to 30 ft wide. Steam coming off it at dawn.',
  photos: [
    { photoId: 'p1', thumbUrl: null },
    { photoId: 'p2', thumbUrl: null },
  ],
};

/** 2.3: thin ice off Black Point — older, reported healing. */
export const HAZARD_THIN: HazardPanelData = {
  ...HAZARD_LEAD,
  hazardId: 'h2',
  type: 'thin_ice',
  title: 'Thin ice',
  subAreaName: 'Mascoma South',
  freshnessLabel: 'Not confirmed recently',
  fresh: false,
  badges: ['Reported healing'],
  reporter: { displayName: 'Ana Morales', username: 'amorales' },
  byline: 'Reported Jan 4 by Ana Morales · confirmed by Matt Ochs',
  notes: [
    'May have thickened or reopened since — thin new ice can weaken in under an hour.',
    'Reported healing, but still called unsafe by the last skater who looked.',
  ],
  description:
    'Gray, wet-looking patch off the point where the brook comes in. Rang hollow under the pole.',
  photos: [],
};

/** 2.4: Pat's report, today, from the launch to the islands. */
export const REPORT_PAT: ReportPanelData = {
  reportId: 'r1',
  title: 'Mascoma South',
  when: 'Today · off the ice 11:40 AM · skated 2h',
  author: { displayName: 'Pat Lacasse', username: 'placasse' },
  authorBlocked: false,
  claims: {
    suitabilityLabel: 'Experienced only',
    isDontGo: false,
    qualityLabel: 'Good',
    vantageLabel: null,
    sightingLabels: [],
  },
  postTitle: 'Black ice to the islands',
  postBody:
    'Black ice from the launch to the islands, a skim of new snow past them. Drilled 5″ off the beach and 4″ near the islands. Wind picked up from the northwest around 11.',
  iceTypes: ['Black ice', 'Snow ice'],
  surfaceTags: ['Smooth', 'Snow covered'],
  thickness: ['5″ · drilled · off the beach', '4″ · drilled · near the islands'],
  snow: 'A skim, under ½″, past the islands',
  conditions: [
    { label: 'Air temp', value: '12 → 18°F' },
    { label: 'Wind', value: 'NW 4 to 9 mph' },
    { label: 'Sky', value: 'Clear' },
    { label: 'Put in at', value: 'Mascoma Lake Boat Launch' },
  ],
  siblings: [{ reportId: 'r9', bodyName: 'Mascoma North' }],
  photos: [
    { photoId: 'p1', url: null, thumbUrl: null },
    { photoId: 'p2', url: null, thumbUrl: null },
    { photoId: 'p3', url: null, thumbUrl: null },
  ],
  trackClipped: false,
  bountiesAnswered: 0,
};

/** 2.6: the open ask on Mascoma North — three want a report. */
export const BOUNTY_NORTH: BountyPanelData = {
  title: 'Mascoma North',
  status: 'Open · expires in 2d · only a report from this bay fulfills it',
  open: true,
  mine: false,
  // Newest first, as the server lists them: Rob asked first.
  wanters: [
    { displayName: 'Matt Ochs' },
    { displayName: 'Ana Morales' },
    { displayName: 'Rob Tremblay' },
  ],
  scope: 'Mascoma North, in Mascoma Lake',
  candidates: [
    {
      reportId: 'r2',
      authorName: 'Sarah Berman',
      when: 'Thu 3:15 PM',
      qualityLabel: null,
      isOwn: false,
    },
    {
      reportId: 'r3',
      authorName: 'Ana Morales',
      when: 'Fri 2:40 PM',
      qualityLabel: 'Fair',
      isOwn: false,
    },
  ],
};

/** 2.7: Kate's own, on the whole lake. */
export const BOUNTY_MINE: BountyPanelData = {
  title: 'Mascoma Lake',
  status: 'Open · expires in 5d',
  open: true,
  mine: true,
  wanters: [{ displayName: 'Kate Donovan' }],
  scope: 'Any part of Mascoma Lake',
  candidates: [
    {
      reportId: 'r1',
      authorName: 'Pat Lacasse',
      when: 'Today 11:40 AM',
      qualityLabel: 'Good',
      isOwn: false,
    },
  ],
};

// ── Cards (rows 1, 4 and 6) ─────────────────────────────────────────────────────────────────────

const box = { minLat: 43.62, minLng: -72.36, maxLat: 43.68, maxLng: -72.28 };
const mascoma = {
  rings: [
    [
      [-72.355, 43.664],
      [-72.33, 43.676],
      [-72.305, 43.672],
      [-72.29, 43.655],
      [-72.3, 43.635],
      [-72.325, 43.625],
      [-72.345, 43.638],
      [-72.355, 43.664],
    ] as [number, number][],
  ],
  bbox: box,
  origin: { lat: 43.65, lng: -72.32 },
};

export const CARD_PAT: FeedCardData = {
  reportId: 'r1',
  waterBodyId: 'w1',
  bodyName: 'Mascoma Lake',
  subAreaName: 'Mascoma South',
  skateEndTime: at(16, 11, 40),
  skateStartTime: at(16, 9, 40),
  iceTypes: ['black_ice'],
  surfaceTags: ['snow_covered'],
  skateQuality: 'good',
  suitability: 'experienced_only',
  observedFrom: 'on_ice',
  photoThumbUrls: [],
  author: { displayName: 'Pat Lacasse', username: 'placasse' },
  blocked: false,
  silhouette: mascoma,
};

export const CARD_SARAH: FeedCardData = {
  reportId: 'r2',
  waterBodyId: 'w1',
  bodyName: 'Mascoma Lake',
  subAreaName: 'Mascoma North',
  skateEndTime: at(14, 15, 15),
  iceTypes: [],
  surfaceTags: [],
  suitability: 'dont_go',
  observedFrom: 'shore',
  sightings: [{ type: 'open' }],
  photoThumbUrls: [],
  author: { displayName: 'Sarah Berman', username: 'sberman' },
  blocked: false,
};

export const CARD_KATE_BLOCKED: FeedCardData = {
  reportId: 'r3',
  waterBodyId: 'w1',
  bodyName: 'Mascoma Lake',
  subAreaName: 'Mascoma South',
  skateEndTime: at(13, 9, 5),
  skateStartTime: at(13, 7, 35),
  iceTypes: ['snow_ice'],
  surfaceTags: ['bumpy'],
  skateQuality: 'fair',
  suitability: 'not_for_beginners',
  photoThumbUrls: [],
  author: { displayName: 'Kate Donovan', username: 'kdonovan' },
  blocked: true,
};

/** A card with no bay: the lake is the finest name it carries. */
function lakeOnly(card: FeedCardData): FeedCardData {
  const { subAreaName: _bay, ...rest } = card;
  return rest;
}

export const POST_ANA: PostCardData = {
  postId: 'post-ana',
  title: 'Two stops on the way home',
  latestSkateEndTime: at(16, 16, 50),
  author: { displayName: 'Ana Morales', username: 'amorales' },
  blocked: false,
  isFavorite: false,
  omittedCount: 0,
  reports: [
    {
      ...lakeOnly(CARD_PAT),
      reportId: 'r4',
      bodyName: 'Crystal Lake',
      place: { town: 'Enfield', state: 'NH' },
      skateStartTime: at(16, 14, 10),
      skateEndTime: at(16, 14, 55),
      suitability: 'beginner_friendly',
      skateQuality: 'great',
      isFavorite: true,
      author: { displayName: 'Ana Morales', username: 'amorales' },
    },
    {
      ...lakeOnly(CARD_KATE_BLOCKED),
      reportId: 'r5',
      bodyName: 'Smith Pond',
      blocked: false,
      accessKind: 'hike_in',
      skateStartTime: at(16, 15, 40),
      skateEndTime: at(16, 16, 10),
      author: { displayName: 'Ana Morales', username: 'amorales' },
    },
  ],
};
