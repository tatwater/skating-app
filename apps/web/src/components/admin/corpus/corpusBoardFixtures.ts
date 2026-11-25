import type { ClaimSource, WaterBodyClass } from '@skating/core';

import { bodyId, LANES, NOW, taskId } from './corpusFixtures';
import type { CorpusLanesView, CorpusRowOf } from './corpusTypes';
import { GROTON } from './handlers/Classes/classesFixtures';
import { BASIN } from './handlers/Names/namesFixtures';

/**
 * **The boards' own lists** (4.2, 4.3), row for row as the mocks draw them — the public catalogs'
 * lakes and towns, no person — so a story renders beside its board and reads the same. The open row
 * is the handler builder's fixture (*The Basin*, Groton's unnamed water), so the inspector beside
 * the list is the board's. Story support only.
 */

const ALLOWED_NAMES = { pickName: null, keepName: null };
const ALLOWED_CLASSES = { setClass: null, keepClass: null };

type How = 'diff' | 'one' | 'holds';
const FACET = { diff: 'different', one: 'oneLetter', holds: 'qualifier' } as const;

function nameRow(
  seed: string,
  shown: string,
  other: string,
  how: How,
  place: string,
  acres: number,
): CorpusRowOf<'nameConflicts'> {
  return {
    lane: 'nameConflicts',
    taskId: taskId(seed),
    facet: FACET[how],
    filedAt: NOW - 3 * 86_400_000,
    body: { id: bodyId(seed), name: shown, place, cls: 'lakePond', acres },
    can: ALLOWED_NAMES,
    decided: null,
    shown,
    other,
  };
}

/** Board 4.2's list, in its order; *The Basin* is the open row. */
export const NAME_BOARD_ROWS: CorpusRowOf<'nameConflicts'>[] = [
  nameRow('eastgrand', 'East Grand Lake', 'Grand Lake', 'holds', 'Weston, ME', 16070),
  {
    lane: 'nameConflicts',
    taskId: BASIN.taskId,
    facet: BASIN.facet,
    filedAt: BASIN.filedAt,
    body: BASIN.body,
    can: BASIN.can,
    decided: null,
    // The item carries its names as choices; the row, as the board writes it.
    shown: 'The Basin',
    other: 'Lake Auburn',
  },
  nameRow('silver', 'Silver Lake', 'Mattakeunk Pond', 'diff', 'Lee, ME', 1040),
  nameRow('averill', 'Great Averill Pond', 'Big Averill Lake', 'diff', 'Norton, VT', 820),
  nameRow('littlesunapee', 'Little Lake Sunapee', 'Lake Sunapee', 'holds', 'New London, NH', 470),
  nameRow('mollys', 'Mollys Falls Pond', 'Mollys Falls Reservoir', 'diff', 'Cabot, VT', 411),
  nameRow('stinson', 'Stinson Lake', 'Stinson Pond', 'diff', 'Rumney, NH', 340),
  nameRow('iroquois', 'Lake Iroquois', 'Hinesburg Pond', 'diff', 'Hinesburg, VT', 243),
  nameRow('elmore', 'Lake Elmore', 'Elmore Pond', 'diff', 'Elmore, VT', 219),
  nameRow('elligo', 'Little Elligo Pond', 'Little Eligo Pond', 'one', 'Greensboro, VT', 178),
  nameRow('hardwick', 'Hardwick Lake', 'Hardwick Pond', 'diff', 'Hardwick, VT', 140),
  nameRow('dix', 'Thurman W. Dix Reservoir', 'Therman W. Dix Reservoir', 'one', 'Orange, VT', 122),
  nameRow('runnemede', 'Lake Runnemede', 'Lake Runnenede', 'one', 'Windsor, VT', 51),
  nameRow('turtle', 'Turtle Pond', 'Tuttle Pond', 'one', 'Canaan, NH', 38),
];

function classRow(
  seed: string,
  name: string,
  place: string,
  nhd: WaterBodyClass,
  osm: WaterBodyClass,
  acres: number,
): CorpusRowOf<'classConflicts'> {
  const claim = (source: ClaimSource, cls: WaterBodyClass) => ({
    source,
    cls,
    token: null,
    acres: null,
  });
  return {
    lane: 'classConflicts',
    taskId: taskId(seed),
    facet:
      (nhd === 'wetland' && osm === 'lakePond') || (nhd === 'lakePond' && osm === 'wetland')
        ? 'wetlandOrLake'
        : 'otherPairs',
    filedAt: NOW - 4 * 86_400_000,
    body: { id: bodyId(seed), name, place, cls: osm, acres },
    can: ALLOWED_CLASSES,
    decided: null,
    claims: [claim('nhd', nhd), claim('osm', osm)],
  };
}

/** Board 4.3's list, in its order; Groton's unnamed water is the open row. */
export const CLASS_BOARD_ROWS: CorpusRowOf<'classConflicts'>[] = [
  classRow('bog', 'Bog Pond', 'Holland, VT', 'wetland', 'lakePond', 38),
  classRow('errol', '', 'Errol, NH', 'wetland', 'reservoir', 31),
  classRow('deadwater', 'Little Black Deadwater', 'Ashland, ME', 'wetland', 'river', 27),
  classRow('rand', 'Rand Cove', 'Norton, VT', 'lakePond', 'bay', 22),
  classRow('mud', 'Mud Pond', 'Craftsbury, VT', 'wetland', 'lakePond', 16),
  classRow('barnet', '', 'Barnet, VT', 'wetland', 'lakePond', 9),
  {
    lane: 'classConflicts',
    taskId: GROTON.taskId,
    facet: GROTON.facet,
    filedAt: GROTON.filedAt,
    body: GROTON.body,
    can: GROTON.can,
    decided: null,
    claims: GROTON.claims,
  },
  classRow('black', 'Black Pond', 'Hubbardton, VT', 'wetland', 'lakePond', 5),
  classRow('lyme', '', 'Lyme, NH', 'wetland', 'lakePond', 4),
  classRow('spruce', 'Spruce Pond', 'Orford, NH', 'wetland', 'lakePond', 3),
  classRow('orford', '', 'Orford, NH', 'wetland', 'lakePond', 2),
  classRow('peacham', '', 'Peacham, VT', 'wetland', 'lakePond', 2),
];

/** The lanes' counts as the boards draw them (132 of the class conflicts are bog or open water). */
export const BOARD_LANES: CorpusLanesView = {
  lanes: {
    nameConflicts: LANES.lanes.nameConflicts,
    classConflicts: { open: 140, facets: { wetlandOrLake: 132, otherPairs: 8 } },
  },
  pending: false,
};
