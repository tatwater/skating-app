/**
 * Home as boards 1.1–1.3 draw it, on the pinned clock: "now" is `BOARD_NOON` (Saturday 16 January
 * 2027, noon), so every age and clock word reads the same on every runner. The boards' own day was
 * a Wednesday in October; their times keep their order and shape, moved onto this Saturday.
 *
 * Constants only — this file is reached from stories, so it reads no clock and imports no runner.
 */
import { BOARD_NOON } from '@/test/boardNow';

import type { OverviewHomeData } from './OverviewHome';
import type { FeedRow, MachineryCardData } from './overviewData';

export const NOW = BOARD_NOON;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Local midnight `days` before the board's day, plus a time of day. */
const at = (daysAgo: number, h: number, m: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

/** A calendar day this season (October 2026 – January 2027). */
const day = (month: number, date: number, year = month >= 6 ? 2026 : 2027) =>
  new Date(year, month, date).getTime();

export const MACHINERY: MachineryCardData = {
  jobs: [
    // Quiet for 41 minutes: a stalled run's time is its silence.
    { id: 'corpus-load', name: 'Corpus · load bodies', state: 'stalled', at: NOW - 41 * MIN },
    { id: 'depth-load', name: 'Depth load', state: 'failed', at: at(1, 22, 14) },
    { id: 'orphan-photos', name: 'Retention · orphan photos', state: 'failed', at: at(0, 4, 12) },
    { id: 'weather-appends', name: 'Weather appends', state: 'late', at: at(0, 2, 4) },
    { id: 'forecast-prune', name: 'Forecast cache prune', state: 'retried', at: at(0, 10, 6) },
    { id: 'imagery', name: 'Imagery', state: 'ok', at: NOW - 3 * MIN },
    { id: 'ice-watch', name: 'Ice watch check', state: 'ok', at: at(0, 8, 10) },
  ],
  more: 28,
  moreAllOk: true,
};

const feed = (
  id: string,
  when: number,
  actor: string | null,
  action: string,
  type: string,
  label: string,
): FeedRow => ({ id, at: when, actor, action, target: { type, id: `${type}-${id}`, label } });

export const FEED: FeedRow[] = [
  feed(
    'a1',
    at(0, 11, 41),
    'Sarah',
    'Declined request',
    'waterBodyRequest',
    'name_bay · "Shaker cove"',
  ),
  feed('a2', at(0, 11, 2), 'Teagan', 'Set curated boost 0.3', 'waterbody', 'Mascoma Lake'),
  feed('a3', at(0, 10, 20), null, 'Activated body', 'waterbody', 'Post Pond, Lyme NH'),
  feed('a4', at(0, 4, 12), null, 'Run failed', 'importRun', 'retention · orphan photos'),
  feed('a5', at(1, 22, 14), null, 'Run failed', 'importRun', 'lake_depth · VT bathymetry join'),
  feed('a6', at(1, 19, 48), 'Matt', 'Suspended 3 d', 'user', 'Rob Tremblay'),
  feed(
    'a7',
    at(1, 19, 46),
    'Matt',
    'Actioned flag · hid report',
    'report',
    'Mascoma Lake · 15 Jan',
  ),
  feed(
    'a8',
    at(1, 9, 12),
    'Teagan',
    'Saved mouth (chord)',
    'waterBodySubArea',
    'Malletts Bay · Champlain',
  ),
  feed('a9', at(2, 16, 30), 'Teagan', 'Started imagery', 'season', 'winter-2026-27'),
  feed(
    'a10',
    at(2, 11, 5),
    'Teagan',
    'Approved request',
    'waterBodyRequest',
    'unnamed pond · Groton VT',
  ),
  feed('a11', at(2, 10, 48), 'Sarah', 'Dismissed flag', 'comment', 'comment · Lake Morey report'),
  feed('a12', at(3, 21, 30), null, 'Run succeeded', 'importRun', 'landmark_seed · 237 queued'),
  feed('a13', at(3, 18, 2), 'Teagan', 'Named landmark', 'bodyLandmark', '"the Narrows" · Mascoma'),
  feed('a14', at(3, 9, 40), null, 'Watch checked', 'season', 'Upper Lake of the Clouds'),
  feed('a15', at(4, 23, 10), null, 'Rollup ran', 'season', 'season · 11 statistics'),
  feed('a16', at(4, 17, 22), 'Sarah', 'Hid comment', 'comment', 'Lake Morey · spam'),
  feed(
    'a17',
    at(4, 9, 15),
    'Teagan',
    'Ruled public access',
    'waterbody',
    'Tomhannock Reservoir · accessible',
  ),
  feed('a18', at(5, 20, 40), null, 'Run succeeded', 'importRun', 'weather cells · 41 refreshed'),
  feed('a19', at(5, 14, 2), 'Matt', 'Approved request', 'waterBodyRequest', 'activate · Post Pond'),
  feed('a20', at(5, 11, 30), 'Teagan', 'Named landmark', 'bodyLandmark', '"Black Point" · Mascoma'),
  feed('a21', at(6, 22, 5), null, 'Rollup ran', 'season', 'season · 11 statistics'),
  feed(
    'a22',
    at(6, 16, 48),
    'Sarah',
    'Declined request',
    'waterBodyRequest',
    'admit · farm pond, Etna',
  ),
  feed('a23', at(7, 8, 10), null, 'Watch checked', 'season', '2 of 3 sentinels under 32 °F'),
  feed('a24', at(8, 19, 30), 'Teagan', 'Set curated boost 0.2', 'waterbody', 'Lake Morey'),
  feed('a25', at(9, 12, 0), null, 'Run succeeded', 'importRun', 'NWS alerts · 0 active'),
];

/** Board 1.1: Home as the founder reviewed it. */
export const HOME: OverviewHomeData = {
  watch: { state: 'open', since: day(9, 3), sentinels: 2, of: 3, byRegion: false },
  winter: { state: 'set', from: day(9, 7), nights: 1, frozen: 11, reporting: 25, needs: 13 },
  imagery: { state: 'running', granules: 0, cutterPinnedAt: day(9, 11), lastLandedAt: null },
  firstSkate: { at: null, body: null, lastWinter: { at: day(11, 6, 2025), body: 'Crystal Lake' } },
  cost: {
    total: '$75.80',
    totalSub: '$70.00 invoiced · $5.80 metered',
    services: [
      {
        id: 'hosting',
        label: 'Convex · Vercel · R2',
        amount: '$70.00',
        sub: 'R2 2.4 of 10 GB free',
        meter: { value: 2.4, max: 10, label: 'R2 storage' },
      },
      {
        id: 'ai',
        label: 'Anthropic · TypeSafe',
        amount: '$5.68',
        sub: '2.1 M tokens · $1.78 this month',
      },
      {
        id: 'compute',
        label: 'Fly · imagery cutters',
        amount: '$0.12',
        sub: '38 machine-min · all this month',
      },
      {
        id: 'open-meteo',
        label: 'Open-Meteo',
        amount: null,
        sub: 'Today 1,940 of 10,000 weighted calls',
        meter: { value: 1940, max: 10_000, label: 'Open-Meteo calls today' },
      },
      {
        id: 'ors',
        label: 'OpenRouteService',
        amount: null,
        sub: 'Today 18 of 2,000 requests',
        meter: { value: 18, max: 2000, label: 'OpenRouteService requests today' },
      },
      {
        id: 'resend',
        label: 'Resend',
        amount: null,
        sub: 'January 14 of 3,000 emails',
        meter: { value: 14, max: 3000, label: 'Resend emails this month' },
      },
    ],
    months: [
      { at: day(9, 1), hosting: 0, ai: 0, compute: 0 },
      { at: day(10, 1), hosting: 25, ai: 0, compute: 0 },
      { at: day(11, 1), hosting: 44.5, ai: 4.4, compute: 0 },
      { at: day(0, 1), hosting: 0, ai: 1.4, compute: 0.5 },
    ],
  },
  inbox: {
    lanes: {
      safety: { count: 1, capped: false },
      accessReports: { count: 3, capped: false },
      requests: { count: 6, capped: false },
      placesAsked: { count: 4, capped: false },
      drawnBodies: { count: 1, capped: false },
      contentFlags: { count: 2, capped: false },
      support: { count: 2, capped: false },
    },
    oldestOpenAt: NOW - 4 * DAY - 3 * HOUR,
    medianOpenedAt: NOW - 1.5 * DAY,
  },
  corpus: {
    duplicates: { count: 283, capped: false },
    nameConflicts: { count: 412, capped: false },
    classConflicts: { count: 140, capped: false },
    orphanBays: { count: 61, capped: false },
    chordRefits: { count: 2, capped: false },
    placeNames: { count: 237, capped: false },
    preIcePass: { state: 'not-run' },
    enrichment: { count: 58, capped: false },
    campaignAt: day(0, 12),
  },
  machinery: MACHINERY,
  people: {
    admins: { count: 2, capped: false },
    moderators: { count: 1, capped: false },
    newThisWeek: { count: 2, capped: false },
    suspended: { count: 1, capped: false },
    nextSuspensionEnds: day(0, 19),
    banned: { count: 0, capped: false },
    flaggedPeople: { count: 1, capped: false },
    appealsOpen: { count: 1, capped: false },
    leaving: { count: 0, capped: false },
    totalUsers: { count: 38, capped: false },
  },
  feed: FEED,
};

/** When the feed last heard from the server on board 1.1 (live) and 1.3 (gone quiet). */
export const LAST_CHECKED_LIVE = NOW - 29_000;
export const LAST_CHECKED_QUIET = NOW - 6 * MIN - 26_000;

/** A moderator's Home: no support lane, no appeals (support is PII, D37). */
export const HOME_MODERATOR: OverviewHomeData = {
  ...HOME,
  inbox: HOME.inbox && { ...HOME.inbox, lanes: { ...HOME.inbox.lanes, support: null } },
  people: HOME.people && { ...HOME.people, appealsOpen: null },
};
