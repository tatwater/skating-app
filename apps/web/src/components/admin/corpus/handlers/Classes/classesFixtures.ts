import { classConsequence, SQM_PER_ACRE, type WaterBodyClass, zonedInstant } from '@skating/core';

import type { DecidedState } from '../../../inspector/InspectorFrame';
import type { ClassesItem } from './classesModel';

/**
 * **Board 4.3's class conflict, as `corpusTasks.item` returns it** — for stories and tests only
 * (`fixturesStayInStories.test.ts`). The unnamed 5 ac water in Groton, VT: OpenStreetMap draws a
 * pond, NHD a swamp, so the ladder suggests Wetland; and the states the task can be in: before the
 * campaign that records the catalogs' claims, decided, and refused. The consequences are core's
 * `classConsequence` for the body, as the read serves them — one rule, so a story can't draw words
 * the server never says (the board's own *Stays, as moving water under the ice* is not one, D3).
 */

/**
 * The board's “today”: noon on 14 Oct 2026 in the board's zone, an absolute instant whatever the
 * runner's zone (as `NAMES_NOW` is).
 */
export const CLASSES_NOW = zonedInstant(2026, 10, 14, 12 * 60, 'America/New_York');
const D = 24 * 3_600_000;
const id = (s: string) => s.padEnd(32, '0') as never;

/** Groton's unnamed 5 ac water, as the size rules read it. */
export const GROTON_SIZE = { name: '', surfaceAreaSqM: 5 * SQM_PER_ACRE };

const rung = (
  cls: WaterBodyClass,
  byCatalog: Record<string, string>,
  flags: { now?: boolean; suggested?: boolean } = {},
) => ({
  cls,
  now: flags.now ?? false,
  suggested: flags.suggested ?? false,
  byCatalog,
  consequence: classConsequence(GROTON_SIZE, cls),
});

const LADDER = [
  rung('lakePond', { osm: 'osm:water=pond' }, { now: true }),
  rung('wetland', { nhd: 'nhd:SwampMarsh' }, { suggested: true }),
  rung('reservoir', {}),
  rung('river', {}),
  rung('bay', {}),
];

/** The board's record, every fact recorded. */
export const GROTON = {
  lane: 'classConflicts',
  taskId: id('ctgroton'),
  facet: 'wetlandOrLake',
  filedAt: CLASSES_NOW - 2 * D,
  body: { id: id('wbgroton'), name: '', place: 'Groton, VT', cls: 'lakePond', acres: 5 },
  can: { keepClass: null, setClass: null },
  decided: null,
  raisedBy: { campaignId: 'c-2026-10-12', at: CLASSES_NOW - 2 * D },
  raisedAgain: null,
  attached: { reports: 0, landmarks: 0, asks: 0, capped: false },
  // Its middle a mile and a tenth north of Groton's (the board's *Osmore Pond · 1.1 mi north*).
  neighbors: [{ id: id('wbosmore'), name: 'Osmore Pond', offset: { meters: 1770, bearingDeg: 2 } }],
  ladder: LADDER,
  claims: [
    { source: 'nhd', cls: 'wetland', token: 'fcode=46600', acres: 7 },
    { source: 'osm', cls: 'lakePond', token: 'water=pond', acres: 5 },
  ],
  depth: null,
} as unknown as ClassesItem;

/**
 * The same task on dev today: loaded before the campaign that records the claims — no catalog
 * columns, no catalogs’ rows, nothing suggested, its geometry facts not computed yet.
 */
export const GROTON_NOT_RECORDED = {
  ...GROTON,
  raisedBy: null,
  neighbors: null,
  claims: null,
  ladder: LADDER.map((r) => ({ ...r, suggested: false, byCatalog: {} })),
} as unknown as ClassesItem;

const ALREADY = 'This has already been decided.';

/** Decided a few minutes ago by another staff member: set as Wetland. */
export const GROTON_DECIDED = {
  ...GROTON,
  body: { ...GROTON.body, cls: 'wetland' },
  can: { keepClass: ALREADY, setClass: ALREADY },
  decided: {
    at: CLASSES_NOW - 10 * 60_000,
    by: { userId: id('prkate'), displayName: 'Kate Donovan' },
    decision: 'reclassed',
    actionId: id('macorpus2'),
    byMe: false,
  },
  ladder: LADDER.map((r) => ({ ...r, now: r.cls === 'wetland', suggested: false })),
} as unknown as ClassesItem;

export const GROTON_LOCK: DecidedState = {
  by: 'Kate Donovan',
  at: CLASSES_NOW - 10 * 60_000,
  decisionWord: 'reclassed',
  byMe: false,
  actionId: 'macorpus2',
};

/** Every verb refused: the body was removed since the campaign asked. */
export const GROTON_REFUSED = {
  ...GROTON,
  can: {
    keepClass: 'This body was removed from the corpus since this was asked.',
    setClass: 'This body was removed from the corpus since this was asked.',
  },
} as unknown as ClassesItem;

/** A depth on file and a claim stored before its code and area were (one catalog of two). */
export const GROTON_MIXED = {
  ...GROTON,
  depth: { meters: 2.4, source: 'a state survey', measure: 'max' },
  claims: [
    { source: 'nhd', cls: 'wetland', token: null, acres: null },
    { source: 'osm', cls: 'lakePond', token: 'water=pond', acres: 5 },
  ],
} as unknown as ClassesItem;
