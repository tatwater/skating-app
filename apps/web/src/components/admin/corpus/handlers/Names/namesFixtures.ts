import { zonedInstant } from '@skating/core';

import type { DecidedState } from '../../../inspector/InspectorFrame';
import type { NamesItem } from './namesModel';

/**
 * **Board 4.2's name conflict, as `corpusTasks.item` returns it** — for stories and tests only (the
 * page draws only what a read returned, `fixturesStayInStories.test.ts`). The Basin in Auburn, ME,
 * which OpenStreetMap calls Lake Auburn, and the other states the task can be in: before the
 * campaign that records each spelling's catalogs, decided, and refused. Nothing is suggested
 * (D308: 6c's emails name a suggestion), so every one opens on the shown name.
 */

/**
 * The board's “today”: noon on 14 Oct 2026 in the board's zone (the tests format in New York), an
 * absolute instant whatever the runner's zone — a local-time clock moved the 40-days-ago decision
 * to 3 Sep under UTC+14.
 */
export const NAMES_NOW = zonedInstant(2026, 10, 14, 12 * 60, 'America/New_York');
const D = 24 * 3_600_000;
const id = (s: string) => s.padEnd(32, '0') as never;

/** The Basin, its neighbors and the campaign that queued it: the board's record, every fact recorded. */
export const BASIN = {
  lane: 'nameConflicts',
  taskId: id('ctbasin'),
  facet: 'different',
  filedAt: NAMES_NOW - 2 * D,
  body: {
    id: id('wbbasin'),
    name: 'The Basin',
    place: 'Auburn, ME',
    cls: 'lakePond',
    acres: 2263,
  },
  can: { keepName: null, pickName: null },
  decided: null,
  raisedBy: { campaignId: 'c-2026-10-12', at: NAMES_NOW - 2 * D },
  raisedAgain: null,
  attached: { reports: 3, landmarks: 1, asks: 0, capped: false },
  neighbors: [
    { id: id('wbtaylor'), name: 'Taylor Pond' },
    { id: id('wbgulfisland'), name: 'Gulf Island Pond' },
  ],
  split: 'different',
  names: [
    {
      value: 'The Basin',
      sources: ['gnis', 'nhd', '3dhp'],
      sourcesRecorded: true,
      rankWords: 'First: the authority on US names',
      shown: true,
      suggested: false,
      namesakes: { count: 14, capped: false },
    },
    {
      value: 'Lake Auburn',
      sources: ['osm'],
      sourcesRecorded: true,
      rankWords: 'Last: a mapper’s free text',
      shown: false,
      suggested: false,
      namesakes: { count: 0, capped: false },
    },
  ],
} as unknown as NamesItem;

/**
 * The same task on dev today: a body loaded before the campaign that records each spelling's
 * catalogs — one catalog per spelling, no campaign on file, its geometry facts not computed yet.
 */
export const BASIN_NOT_RECORDED = {
  ...BASIN,
  raisedBy: null,
  neighbors: null,
  names: BASIN.names.map((n) => ({
    ...n,
    sources: n.sources.slice(0, 1),
    sourcesRecorded: false,
  })),
} as unknown as NamesItem;

const ALREADY = 'This has already been decided.';

/** Decided a few minutes ago by another staff member: Lake Auburn displayed. */
export const BASIN_DECIDED = {
  ...BASIN,
  body: { ...BASIN.body, name: 'Lake Auburn' },
  can: { keepName: ALREADY, pickName: ALREADY },
  decided: {
    at: NAMES_NOW - 10 * 60_000,
    by: { userId: id('prkate'), displayName: 'Kate Donovan' },
    decision: 'renamed',
    actionId: id('macorpus1'),
    byMe: false,
  },
  names: BASIN.names.map((n) => ({ ...n, shown: n.value === 'Lake Auburn' })),
} as unknown as NamesItem;

/** The lock the frame draws over `BASIN_DECIDED`. */
export const BASIN_LOCK: DecidedState = {
  by: 'Kate Donovan',
  at: NAMES_NOW - 10 * 60_000,
  decisionWord: 'renamed',
  byMe: false,
  actionId: 'macorpus1',
};

/** Every verb refused: the body was merged away since the campaign asked. */
export const BASIN_REFUSED = {
  ...BASIN,
  can: {
    keepName: 'The Basin was merged into another body since this was asked.',
    pickName: 'The Basin was merged into another body since this was asked.',
  },
} as unknown as NamesItem;

/** Settled once, asked again: a catalog's spelling changed since (D306). */
export const BASIN_ASKED_AGAIN = {
  ...BASIN,
  raisedAgain: {
    previous: {
      at: NAMES_NOW - 40 * D,
      by: { userId: id('prkate'), displayName: 'Kate Donovan' },
      decision: 'kept',
      actionId: id('macorpus0'),
      byMe: false,
    },
  },
} as unknown as NamesItem;
