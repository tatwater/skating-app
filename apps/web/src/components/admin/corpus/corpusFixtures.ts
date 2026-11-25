import type { Id } from '@skating/convex/dataModel';
import { zonedInstant } from '@skating/core';

import type {
  CorpusDecidedView,
  CorpusItemOf,
  CorpusLanesView,
  CorpusListPage,
  CorpusRowOf,
  CorpusRowView,
  CorpusTaskItemView,
} from './corpusTypes';

/**
 * **The boards' Corpus tasks, as the reads would return them** (4.2, 4.3) — for stories and tests
 * only; the page never draws a fixture. Bodies and catalogs are the boards'; every person is invented.
 * A handler's own fixtures build on these (`{ ...NAME_ITEM, names: […] }`).
 */

/**
 * The boards' clock: mid-October, the console's working season — noon on 14 Oct 2026 in the boards'
 * zone, an absolute instant whatever the runner's zone (as `NAMES_NOW` is).
 */
export const NOW = zonedInstant(2026, 10, 14, 12 * 60, 'America/New_York');
const DAY = 86_400_000;

/** A Convex-shaped id (32 lowercase characters) from a readable seed. */
const fakeId = (seed: string): string =>
  `k17${seed
    .toLowerCase()
    .replace(/[^0-9a-z]/g, '')
    .padEnd(29, '0')
    .slice(0, 29)}`;

export const taskId = (seed: string) => fakeId(`task${seed}`) as Id<'corpusTasks'>;
export const bodyId = (seed: string) => fakeId(`body${seed}`) as Id<'waterBodies'>;
export const actionId = (seed: string) => fakeId(`act${seed}`) as Id<'moderationActions'>;
const profileId = (seed: string) => fakeId(`prof${seed}`) as Id<'profiles'>;

/** A colleague's decision, two hours ago. */
export const DECIDED_BY_COLLEAGUE: CorpusDecidedView = {
  at: NOW - 2 * 3_600_000,
  by: { userId: profileId('avery'), displayName: 'Avery Lindqvist' },
  decision: 'renamed',
  actionId: actionId('rename1'),
  byMe: false,
};

/** The viewer's own decision, just now. */
export const DECIDED_BY_ME: CorpusDecidedView = {
  at: NOW - 60_000,
  by: { userId: profileId('me'), displayName: 'Jo Marsh' },
  decision: 'kept',
  actionId: actionId('keep1'),
  byMe: true,
};

const ALL_ALLOWED_NAMES = { pickName: null, keepName: null };
const ALL_ALLOWED_CLASSES = { setClass: null, keepClass: null };

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────────────

function nameRow(
  seed: string,
  shown: string,
  other: string,
  facet: 'different' | 'oneLetter' | 'qualifier',
  place: string,
  acres: number | null,
  daysAgo: number,
): CorpusRowOf<'nameConflicts'> {
  return {
    lane: 'nameConflicts',
    taskId: taskId(seed),
    facet,
    filedAt: NOW - daysAgo * DAY,
    body: { id: bodyId(seed), name: shown, place, cls: 'lakePond', acres },
    can: ALL_ALLOWED_NAMES,
    decided: null,
    shown,
    other,
  };
}

/** Board 4.2's list, its first rows. */
export const NAME_ROWS: CorpusRowOf<'nameConflicts'>[] = [
  nameRow('basin', 'The Basin', 'Lake Auburn', 'different', 'Auburn, ME', 2263, 3),
  nameRow('sunapee', 'Sunapee Lake', 'Lake Sunapee', 'qualifier', 'Sunapee, NH', 4085, 3),
  nameRow('winnisquam', 'Lake Winnisquam', 'Lake Winnisquom', 'oneLetter', 'Laconia, NH', 4214, 9),
  nameRow('mascoma', 'Mascoma Lake', 'Mascoma Reservoir', 'qualifier', 'Enfield, NH', 1150, 12),
  nameRow('crystal', 'Crystal Lake', 'Eaton Pond', 'different', 'Eaton, NH', null, 20),
];

function classRow(
  seed: string,
  name: string,
  place: string,
  claims: CorpusRowOf<'classConflicts'>['claims'],
  facet: 'wetlandOrLake' | 'otherPairs' | 'notRecorded',
  acres: number | null,
): CorpusRowOf<'classConflicts'> {
  return {
    lane: 'classConflicts',
    taskId: taskId(seed),
    facet,
    filedAt: NOW - 4 * DAY,
    body: { id: bodyId(seed), name, place, cls: 'lakePond', acres },
    can: ALL_ALLOWED_CLASSES,
    decided: null,
    claims,
  };
}

/** Board 4.3's list: claims recorded, and one body loaded before its campaign carried them. */
export const CLASS_ROWS: CorpusRowOf<'classConflicts'>[] = [
  classRow(
    'hatch',
    'Hatch Pond',
    'Eaton, NH',
    [
      { source: 'osm', cls: 'lakePond', token: 'osm:water=pond', acres: 7 },
      { source: 'nhd', cls: 'wetland', token: 'nhd:fcode=46600', acres: 7 },
    ],
    'wetlandOrLake',
    7,
  ),
  classRow(
    'cold',
    'Cold River Flowage',
    'Acworth, NH',
    [
      { source: 'osm', cls: 'reservoir', token: 'osm:water=reservoir', acres: 31 },
      { source: 'nhd', cls: 'river', token: 'nhd:fcode=46006', acres: null },
    ],
    'otherPairs',
    31,
  ),
  classRow('ossipee', 'Ossipee Marsh', 'Ossipee, NH', null, 'notRecorded', 54),
];

/** A decided row of the names lane (its tail). */
export const NAME_DECIDED_ROW: CorpusRowOf<'nameConflicts'> = {
  ...nameRow('dublin', 'Dublin Lake', 'Dublin Pond', 'qualifier', 'Dublin, NH', 238, 30),
  can: {},
  decided: DECIDED_BY_COLLEAGUE,
};

/** One page of a lane, done. */
export function page(rows: CorpusRowView[], extra: Partial<CorpusListPage> = {}): CorpusListPage {
  return {
    rows,
    isDone: true,
    continueCursor: 'end',
    scanBudgetSpent: false,
    pending: false,
    ...extra,
  };
}

/** The lanes' counts as the boards draw them. */
export const LANES: CorpusLanesView = {
  lanes: {
    nameConflicts: { open: 412, facets: { different: 188, oneLetter: 97, qualifier: 127 } },
    classConflicts: { open: 140, facets: { wetlandOrLake: 0, otherPairs: 0, notRecorded: 140 } },
  },
  pending: false,
};

// ── Items ────────────────────────────────────────────────────────────────────────────────────────────────

const ITEM_EXTRAS = {
  raisedBy: { campaignId: 'n7-3-20260809', at: zonedInstant(2026, 8, 9, 0, 'America/New_York') },
  raisedAgain: null,
  attached: { reports: 14, landmarks: 3, asks: 1, capped: false },
  neighbors: [{ id: bodyId('taylor'), name: 'Taylor Pond' }],
};

/** Board 4.2's open task: *The Basin*, which GNIS and NHD call *Lake Auburn*. */
export const NAME_ITEM: CorpusItemOf<'nameConflicts'> = {
  ...(NAME_ROWS[0] as CorpusRowOf<'nameConflicts'>),
  ...ITEM_EXTRAS,
  split: 'different',
  names: [
    {
      value: 'The Basin',
      sources: ['osm'],
      sourcesRecorded: false,
      rankWords: 'Last: a mapper’s free text',
      shown: true,
      suggested: false,
      namesakes: { count: 14, capped: false },
    },
    {
      value: 'Lake Auburn',
      sources: ['gnis'],
      sourcesRecorded: false,
      rankWords: 'First: the authority on US names',
      shown: false,
      suggested: false,
      namesakes: { count: 2, capped: false },
    },
  ],
};

/** Board 4.3's open task: *Hatch Pond*, a pond to OSM and a swamp to NHD. */
export const CLASS_ITEM: CorpusItemOf<'classConflicts'> = {
  ...(CLASS_ROWS[0] as CorpusRowOf<'classConflicts'>),
  ...ITEM_EXTRAS,
  // Its geometry facts aren't computed yet: no neighbors to name, never "none".
  neighbors: null,
  depth: null,
  ladder: [
    {
      cls: 'lakePond',
      now: true,
      suggested: false,
      byCatalog: { osm: 'osm:water=pond' },
      consequence: { kind: 'stays', words: 'Stays in the corpus as a lake or pond' },
    },
    {
      cls: 'wetland',
      now: false,
      suggested: false,
      byCatalog: { nhd: 'nhd:fcode=46600' },
      consequence: {
        kind: 'leaves',
        words: 'Leaves the corpus next campaign, as unnamed wetland under 50 ac',
      },
    },
  ],
};

/** A task decided by a colleague (a tail row opened, or one decided while open). */
export const NAME_ITEM_DECIDED: CorpusTaskItemView = {
  ...NAME_ITEM,
  can: {},
  decided: DECIDED_BY_COLLEAGUE,
};
