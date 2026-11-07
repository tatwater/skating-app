import type { BodyResultData, FeedCardData, PostCardData } from '@skating/core';

/**
 * Latest's fixtures, drawn from the boards (row 4: "today" is the morning of the posts) — shared by
 * the tests and the stories. Story-and-test only; nothing in the app imports it.
 */

export const NOW = Date.now();
const HOUR = 3_600_000;

export const REPORT: FeedCardData = {
  reportId: 'rep1',
  waterBodyId: 'wb1',
  bodyName: 'Mascoma Lake',
  subAreaName: 'Mascoma South',
  skateEndTime: NOW - 2 * HOUR,
  skateStartTime: NOW - 4 * HOUR,
  iceTypes: ['black_ice'],
  surfaceTags: ['glass'],
  skateQuality: 'great',
  photoThumbUrls: [],
  author: { username: 'placasse', displayName: 'Pat Lacasse' },
  blocked: false,
  isFavorite: true,
} as unknown as FeedCardData;

export const POST: PostCardData = {
  postId: 'post1',
  title: 'Mascoma South, first real day',
  body: 'Black ice from the Shaker Bridge launch to the islands.',
  latestSkateEndTime: NOW - 2 * HOUR,
  author: { username: 'placasse', displayName: 'Pat Lacasse' },
  blocked: false,
  isFavorite: false,
  omittedCount: 0,
  reports: [REPORT],
} as unknown as PostCardData;

export const MATCH: BodyResultData = {
  waterBodyId: 'wb2',
  name: 'Smith Pond',
  type: 'pond',
  states: ['NH'],
  eventMs: NOW - HOUR,
  eventDayMs: NOW - HOUR,
  asOfDayMs: NOW - 24 * HOUR,
  chain: { nights: 5, thresholdF: 20, noSnowSince: true },
  place: { kind: 'body' },
  otherBayNames: [],
  oneSampleForALargeBody: false,
  accessKind: 'hike_in',
  isFavorite: false,
} as unknown as BodyResultData;
