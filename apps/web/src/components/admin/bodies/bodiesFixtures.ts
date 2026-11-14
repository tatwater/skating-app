import { type CompletenessField, COMPLETENESS_FIELDS as FIELDS } from '@skating/core';
import type { Count } from '@/components/admin/overview/overviewModel';
import { MASCOMA_PUT_INS, MASCOMA_RINGS } from '@/components/skater/map/mapStoryData';
import { BOARD_NOON } from '@/test/boardNow';

import type { BodiesListData, BodyPreviewData } from './bodiesData';
import type { BodyRow, BodyStandingKey } from './bodiesModel';

/**
 * Boards 5.1–5.3 as data, on the pinned clock (`BOARD_NOON`, Saturday 16 January 2027, local
 * midday). Story-only: `fixturesStayInStories.test.ts` fails if anything the app mounts reaches
 * this file. The rows are the boards' own; the boards drew completeness out of 12 before Review 13
 * made it 10, so each is rescaled to the 10 fields.
 */

export const NOW = BOARD_NOON;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const COMPLETENESS_FIELDS = FIELDS.length;

/** Local midday `days` ago — a date the boards write as "19 Sep" or "Wed". */
const daysAgo = (days: number) => NOW - days * DAY;
const ACRE = 4046.8564224;

type Spec = [
  name: string,
  cls: 'lake' | 'pond' | 'reservoir' | 'bay',
  states: string,
  acres: number,
  completeOf12: number,
  asks: number,
  reports: number,
  changedAt: number,
  waiting?: boolean,
];

const CLASS = { lake: 'lakePond', pond: 'lakePond', reservoir: 'reservoir', bay: 'bay' } as const;

/** The fields the boards said were missing, longest first, so a row's gaps read believably. */
const GAPS: CompletenessField[] = ['bathymetry', 'lots', 'elevation', 'wind', 'putIns', 'depth'];

function row(spec: Spec, standing: BodyStandingKey = 'active'): BodyRow {
  const [name, cls, states, acres, of12, asks, reports, changedAt, waiting] = spec;
  const have = Math.round((of12 * COMPLETENESS_FIELDS) / 12);
  return {
    id: name.toLowerCase().replace(/[^a-z]+/g, '-'),
    name,
    bodyClass: CLASS[cls],
    states: states.split(' · '),
    areaSqM: acres * ACRE,
    complete: {
      have,
      of: COMPLETENESS_FIELDS,
      missing: GAPS.slice(0, COMPLETENESS_FIELDS - have),
    },
    asks,
    ...(waiting === true && { asksWaiting: true }),
    reports,
    changedAt,
    standing,
  };
}

const LONG_AGO = daysAgo(119); // "19 Sep" on the boards: the last campaign's re-stamp

/** Board 5.1's Active lane, by reports this season (the board's order). */
const ACTIVE_SPECS: Spec[] = [
  ['Mascoma Lake', 'reservoir', 'NH', 1143, 9, 3, 3, NOW - 58 * MIN, true],
  ['Crystal Lake', 'lake', 'NH', 371, 8, 0, 3, daysAgo(3)],
  ['Lake Morey', 'lake', 'VT', 545, 9, 0, 2, daysAgo(1)],
  ['Lake Champlain', 'lake', 'VT · NY', 271000, 12, 2, 1, daysAgo(0.6)],
  ['Malletts Bay · Champlain', 'bay', 'VT', 5840, 9, 0, 1, daysAgo(0.6)],
  ['Post Pond', 'pond', 'NH', 127, 4, 1, 1, NOW - 40 * MIN],
  ['Lake Winnipesaukee', 'lake', 'NH', 44586, 12, 2, 0, LONG_AGO],
  ['Squam Lake', 'lake', 'NH', 6791, 11, 0, 0, LONG_AGO],
  ['Lake Memphremagog', 'lake', 'VT', 6317, 10, 1, 0, LONG_AGO],
  ['Newfound Lake', 'lake', 'NH', 4106, 7, 1, 0, NOW - 5 * HOUR, true],
  ['Lake Sunapee', 'lake', 'NH', 4085, 11, 0, 0, LONG_AGO],
  ['Moore Reservoir', 'reservoir', 'NH · VT', 3490, 6, 1, 0, LONG_AGO],
  ['Lake Bomoseen', 'lake', 'VT', 2360, 9, 0, 0, LONG_AGO],
  ['Lake Seymour', 'lake', 'VT', 1732, 9, 1, 0, LONG_AGO],
  ['Lake Willoughby', 'lake', 'VT', 1687, 10, 0, 0, LONG_AGO],
  ['Tomhannock Reservoir', 'reservoir', 'NY', 1650, 8, 2, 0, daysAgo(4)],
  ['Lake Dunmore', 'lake', 'VT', 985, 10, 0, 0, LONG_AGO],
  ['Great Averill Pond', 'pond', 'VT', 828, 7, 0, 0, LONG_AGO],
  ['Caspian Lake', 'lake', 'VT', 789, 8, 1, 0, NOW - 2 * HOUR, true],
  ['Spofford Lake', 'lake', 'NH', 732, 9, 0, 0, LONG_AGO],
  ['Goose Pond', 'pond', 'NH', 554, 6, 0, 0, LONG_AGO],
  ['Lake Fairlee', 'lake', 'VT', 457, 8, 0, 0, LONG_AGO],
  ['Pemigewasset Lake', 'lake', 'NH', 237, 6, 0, 0, daysAgo(3)],
  ['Shadow Lake', 'lake', 'VT', 210, 6, 0, 0, LONG_AGO],
  ['Lake Eden', 'lake', 'VT', 194, 7, 0, 0, LONG_AGO],
];

/** The big water the size facet adds on board 5.2 (1,000 ac and up). */
const BIG_SPECS: Spec[] = [
  ['Moosehead Lake', 'lake', 'ME', 74890, 11, 0, 0, LONG_AGO],
  ['Sebago Lake', 'lake', 'ME', 28771, 10, 0, 0, LONG_AGO],
  ['Lake George', 'lake', 'NY', 28160, 11, 1, 0, daysAgo(3)],
  ['Great Sacandaga Lake', 'reservoir', 'NY', 26700, 9, 0, 0, LONG_AGO],
  ['Quabbin Reservoir', 'reservoir', 'MA', 24704, 8, 0, 0, LONG_AGO],
  ['Umbagog Lake', 'lake', 'NH · ME', 7850, 9, 0, 0, LONG_AGO],
  ['Rangeley Lake', 'lake', 'ME', 6000, 10, 0, 0, LONG_AGO],
  ['Long Lake', 'lake', 'ME', 4935, 8, 0, 0, LONG_AGO],
  ['Wachusett Reservoir', 'reservoir', 'MA', 4160, 7, 0, 0, LONG_AGO],
  ['Ossipee Lake', 'lake', 'NH', 3092, 9, 0, 0, LONG_AGO],
  ['Lake Carmi', 'lake', 'VT', 1402, 9, 0, 0, LONG_AGO],
];

export const ACTIVE_ROWS: readonly BodyRow[] = ACTIVE_SPECS.map((s) => row(s));
export const BIG_ROWS: readonly BodyRow[] = BIG_SPECS.map((s) => row(s));

const SERVES_ALL = {
  sort: ['name', 'class', 'state', 'acres', 'complete', 'asks', 'reports', 'changed'],
  facets: ['class', 'size', 'outline', 'putins', 'reports', 'complete', 'curation'],
  states: true,
  search: true,
} as const;

export const LANE_COUNTS: Record<string, Count> = {
  opened: { count: 8, capped: false },
  changed: { count: 31, capped: false },
  all: { count: 24871, capped: false },
  active: { count: 1412, capped: false },
  inactive: { count: 22901, capped: false },
  'not-in-campaign': { count: 411, capped: false },
  moderator: { count: 14, capped: false },
  'no-public-access': { count: 72, capped: false },
  removed: { count: 61, capped: false },
};

export const CORPUS: Count = { count: 24871, capped: false };

const STATES = ['NH', 'VT', 'ME', 'NY', 'MA'];

/** Board 5.1: Active, by reports — the first page of 1,412, more to come. */
export const LIST_ACTIVE: BodiesListData = {
  status: 'more',
  rows: ACTIVE_ROWS,
  others: [],
  total: LANE_COUNTS.active as Count,
  serves: SERVES_ALL,
  facetCounts: null,
  states: STATES,
};

/** Board 5.2: one facet applied (1,000 ac and up), 187 of 1,412, the menu's counts. */
export const LIST_BIG: BodiesListData = {
  status: 'more',
  rows: [...ACTIVE_ROWS, ...BIG_ROWS]
    .filter((r) => (r.areaSqM ?? 0) >= 1000 * ACRE)
    .sort((a, b) => (b.reports ?? 0) - (a.reports ?? 0) || (b.areaSqM ?? 0) - (a.areaSqM ?? 0)),
  others: [],
  total: { count: 187, capped: false },
  serves: SERVES_ALL,
  facetCounts: {
    class: { lakePond: 138, reservoir: 39, bay: 10 },
    size: { 'under-10': 412, '10-100': 561, '100-1000': 252, '1000-up': 187 },
    outline: { catalog: 171, drawn: 16 },
    putins: { some: 143, none: 44 },
    reports: { season: 3, never: 61 },
    complete: { all: 9, most: 151, 'under-8': 27 },
    curation: { curated: 52, asks: 7, intake: 18, enrichment: 4 },
  },
  states: STATES,
};

/** Board 5.3: "mor" typed — two active matches, then four dormant ones under their divider. */
export const LIST_SEARCH: BodiesListData = {
  status: 'done',
  rows: [
    row(['Lake Morey', 'lake', 'VT', 545, 9, 0, 2, daysAgo(1)]),
    row(['Moreau Lake', 'lake', 'NY', 128, 7, 0, 0, LONG_AGO]),
  ],
  others: [
    {
      key: 'dormant',
      label: 'Dormant',
      rows: [
        row(['Morey Pond', 'pond', 'NH', 41, 5, 0, 0, daysAgo(121)], 'inactive'),
        row(['Morses Pond', 'pond', 'ME', 63, 4, 0, 0, daysAgo(121)], 'inactive'),
        {
          ...row(['Echo Lake', 'lake', 'VT', 550, 8, 1, 0, daysAgo(106)], 'moderator'),
          matchedAlias: 'Morgan Pond',
        },
        row(['Morrison Lake', 'pond', 'VT', 12, 3, 0, 0, daysAgo(121)], 'not_in_campaign'),
      ],
    },
  ],
  total: { count: 2, capped: false },
  serves: { ...SERVES_ALL, sort: SERVES_ALL.sort },
  facetCounts: null,
  states: ['VT', 'NY'],
};

/** Mascoma as the preview reads it (board 5.1, 5.2). */
export const PREVIEW_MASCOMA: BodyPreviewData = {
  id: 'mascoma-lake',
  name: 'Mascoma Lake',
  bodyClass: 'reservoir',
  states: ['NH'],
  town: 'Enfield',
  moreTowns: ['Canaan'],
  centroid: { lat: 43.63, lng: -72.15 },
  outline: {
    polygons: [MASCOMA_RINGS.map((r) => [...r])],
    bbox: [-72.1819521, 43.6061979, -72.1206902, 43.6497901],
  },
  putIns: MASCOMA_PUT_INS.map(({ lat, lng }) => ({ lat, lng })),
  bays: 2,
  areaSqM: 1143 * ACRE,
  meanDepthM: 9.4,
  maxDepthM: 24,
  elevationM: 229,
  facts: 'ready',
  season: { count: 3, capped: false, sub: '2 on the ice · 1 from shore' },
  allTime: { count: 86, capped: false, sub: 'Since 2023–24' },
  complete: { have: 9, of: COMPLETENESS_FIELDS, missing: ['bathymetry'] },
  asks: [
    {
      id: 'a1',
      kicker: 'Bay name · asked by 3 · Inbox',
      title: '“Shaker cove”',
      sub: 'Near the Shaker Bridge launch',
    },
    {
      id: 'a2',
      kicker: 'Place name · 12 emails',
      title: '“the Narrows”',
      sub: 'A landmark no catalog has',
    },
    {
      id: 'a3',
      kicker: 'Intake · name conflict',
      title: 'Mascoma Lake Reservoir',
      sub: 'OSM vs NHD',
    },
  ],
  history: [
    { id: 'h1', at: NOW - 58 * MIN, actor: 'Teagan', words: 'Set the curated boost' },
    { id: 'h2', at: daysAgo(5), actor: null, words: 'Re-stamped the outline' },
    { id: 'h3', at: daysAgo(0.6), actor: 'Matt', words: 'Hid a report' },
    { id: 'h4', at: daysAgo(106), actor: 'Sarah', words: 'Placed a put-in' },
    { id: 'h5', at: daysAgo(117), actor: 'Teagan', words: 'Ruled public access' },
    { id: 'h6', at: daysAgo(119), actor: 'Sarah', words: 'Drew a sub-area' },
    { id: 'h7', at: daysAgo(135), actor: 'Teagan', words: 'Activated the body' },
  ].sort((a, b) => b.at - a.at),
};

/** Lake Morey's outline, from board 5.3 (a long, narrow north–south lake). */
const MOREY_RING: [number, number][] = [
  [-72.1585, 43.9365],
  [-72.1561, 43.9352],
  [-72.1548, 43.9318],
  [-72.1532, 43.9281],
  [-72.1529, 43.924],
  [-72.1536, 43.9197],
  [-72.1544, 43.9152],
  [-72.1552, 43.911],
  [-72.1561, 43.9072],
  [-72.1575, 43.9046],
  [-72.1597, 43.9041],
  [-72.161, 43.906],
  [-72.1612, 43.9098],
  [-72.1604, 43.9141],
  [-72.1598, 43.9188],
  [-72.1596, 43.9233],
  [-72.1601, 43.9276],
  [-72.1608, 43.9317],
  [-72.1606, 43.9349],
  [-72.1585, 43.9365],
];

/** Lake Morey as the preview reads it under the search (board 5.3). */
export const PREVIEW_MOREY: BodyPreviewData = {
  id: 'lake-morey',
  name: 'Lake Morey',
  bodyClass: 'lakePond',
  states: ['VT'],
  town: 'Fairlee',
  moreTowns: [],
  centroid: { lat: 43.92, lng: -72.15 },
  outline: { polygons: [[MOREY_RING]], bbox: [-72.1612, 43.9041, -72.1529, 43.9365] },
  putIns: [
    { lng: -72.1548, lat: 43.9226 },
    { lng: -72.159, lat: 43.9052 },
  ],
  bays: 0,
  areaSqM: 545 * ACRE,
  meanDepthM: 7.6,
  maxDepthM: 13,
  elevationM: 127,
  facts: 'ready',
  season: { count: 2, capped: false, sub: '2 on the ice' },
  allTime: { count: 41, capped: false, sub: 'Since 2023–24' },
  complete: { have: 9, of: COMPLETENESS_FIELDS, missing: ['bathymetry'] },
  asks: [],
  history: [
    { id: 'm1', at: daysAgo(1), actor: 'Sarah', words: 'Dismissed a flag' },
    { id: 'm2', at: daysAgo(3), actor: 'Sarah', words: 'Hid a comment' },
    { id: 'm3', at: daysAgo(6), actor: 'Teagan', words: 'Set the curated boost' },
    { id: 'm4', at: daysAgo(117), actor: 'Teagan', words: 'Ruled public access' },
    { id: 'm5', at: daysAgo(135), actor: 'Teagan', words: 'Activated the body' },
  ],
};
