import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLASS_ROWS,
  DECIDED_BY_COLLEAGUE,
  NAME_DECIDED_ROW,
  NAME_ROWS,
  NOW,
  page,
} from '../corpusFixtures';
import type { CorpusListPage } from '../corpusTypes';
import { decidedStateOf } from '../inspector/corpusLock';
import { acresText } from '../words/corpusWords';
import { joinPages } from './taskReads';
import { partingLetter, taskRowView } from './taskRows';

const [basin, , , , crystal] = NAME_ROWS;
const [hatch, , ossipee] = CLASS_ROWS;

describe('a task row, as the list draws it', () => {
  it('a name conflict: the shown name over the other, where, its kind and its acres', () => {
    expect(taskRowView(basin as (typeof NAME_ROWS)[number], NOW)).toEqual({
      id: basin?.taskId,
      title: 'The Basin',
      names: [
        { text: 'The Basin', mark: null },
        { text: 'Lake Auburn', mark: null },
      ],
      place: 'Auburn, ME',
      middle: ['Different'],
      acres: '2,263',
      decision: null,
    });
    // No acres recorded: none drawn, never a zero.
    expect(taskRowView(crystal as (typeof NAME_ROWS)[number], NOW).acres).toBeNull();
  });

  it('marks the letter where a one-letter conflict’s names part, and no other kind’s', () => {
    const winnisquam = NAME_ROWS[2] as (typeof NAME_ROWS)[number];
    expect(taskRowView(winnisquam, NOW).names).toEqual([
      { text: 'Lake Winnisquam', mark: 13 },
      { text: 'Lake Winnisquom', mark: 13 },
    ]);
    // A qualifier holds the other name whole: nothing to mark.
    expect(
      taskRowView(NAME_ROWS[1] as (typeof NAME_ROWS)[number], NOW).names.map((n) => n.mark),
    ).toEqual([null, null]);
  });

  it('a name conflict with no other catalog name draws the shown name alone', () => {
    const lone = { ...(basin as (typeof NAME_ROWS)[number]), other: '' };
    expect(taskRowView(lone, NOW).names).toEqual([{ text: 'The Basin', mark: null }]);
  });

  it('a class conflict: the body, then each catalog’s class — or that it isn’t recorded', () => {
    const row = taskRowView(hatch as (typeof CLASS_ROWS)[number], NOW);
    expect(row.names).toEqual([{ text: 'Hatch Pond', mark: null }]);
    expect(row.middle).toEqual(['OSM Lake or pond', 'NHD Wetland']);
    expect(taskRowView(ossipee as (typeof CLASS_ROWS)[number], NOW).middle).toEqual([
      'Not recorded',
    ]);
    // An unnamed body says so, never a blank row.
    const hatchRow = hatch as (typeof CLASS_ROWS)[number];
    const unnamed = { ...hatchRow, body: { ...hatchRow.body, name: '' } };
    expect(taskRowView(unnamed, NOW).title).toBe('Unnamed water');
  });

  it('a decided row says what was decided, by whom and when', () => {
    const row = taskRowView(NAME_DECIDED_ROW, NOW);
    expect(row.decision).toBe('renamed · by Avery Lindqvist · 2 hours ago');
    const gone = taskRowView(
      { ...NAME_DECIDED_ROW, decided: { ...DECIDED_BY_COLLEAGUE, by: null } },
      NOW,
    );
    expect(gone.decision).toBe('renamed · by someone no longer here · 2 hours ago');
  });
});

describe('where two names part', () => {
  it('is the first letter that differs, in each; none in a name that is the other’s start', () => {
    expect(partingLetter('Turtle Pond', 'Tuttle Pond')).toEqual([2, 2]);
    expect(partingLetter('Little Elligo Pond', 'Little Eligo Pond')).toEqual([9, 9]);
    expect(partingLetter('Lake', 'Lakes')).toEqual([null, 4]);
    expect(partingLetter('Same', 'Same')).toEqual([null, null]);
  });

  it('always marks a letter both names share up to, and the letters marked differ', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const [i, j] = partingLetter(a, b);
        const x = [...a];
        const y = [...b];
        const at = i ?? j ?? Math.min(x.length, y.length);
        // Everything before the mark is shared.
        expect(x.slice(0, at)).toEqual(y.slice(0, at));
        if (i !== null && j !== null) {
          expect(i).toBe(j);
          expect(x[i]).not.toBe(y[j]);
        }
        if (i === null) expect(x.length).toBe(at);
        if (j === null) expect(y.length).toBe(at);
      }),
    );
  });
});

describe('the lock’s words', () => {
  it('say the decision in the lane’s words, and a gone decider plainly', () => {
    const decided = NAME_DECIDED_ROW.decided as NonNullable<typeof NAME_DECIDED_ROW.decided>;
    expect(decidedStateOf('nameConflicts', decided)).toEqual({
      by: 'Avery Lindqvist',
      at: decided.at,
      decisionWord: 'renamed',
      byMe: false,
      actionId: decided.actionId,
    });
    expect(
      decidedStateOf('classConflicts', { ...decided, decision: 'kept', by: null }),
    ).toMatchObject({ by: 'someone no longer here', decisionWord: 'class kept' });
  });
});

describe('acres, as the boards write them', () => {
  it('a tenth under ten, whole and grouped above', () => {
    expect(acresText(0.44)).toBe('0.4 ac');
    expect(acresText(9.96)).toBe('10 ac');
    expect(acresText(2263.4)).toBe('2,263 ac');
  });
});

describe('the chain’s pages, joined', () => {
  const more = (rows: CorpusListPage['rows'], extra: Partial<CorpusListPage> = {}) =>
    page(rows, { isDone: false, continueCursor: 'c1', ...extra });

  it('draws each task once, in order, and says whether more can come', () => {
    const first = more(NAME_ROWS.slice(0, 2));
    const second = page(NAME_ROWS.slice(1));
    const joined = joinPages([first, second]);
    expect(joined.rows.map((r) => r.taskId)).toEqual(NAME_ROWS.map((r) => r.taskId));
    expect(joined.status).toBe('done');
    expect(joinPages([first]).status).toBe('more');
    expect(joinPages([first, undefined]).status).toBe('fetching');
    expect(joinPages(null).status).toBe('unread');
  });

  it('stops at the scan’s budget only when the last page says the scan ended it', () => {
    expect(joinPages([more(NAME_ROWS, { scanBudgetSpent: true })]).status).toBe('budget');
    expect(joinPages([page(NAME_ROWS, { scanBudgetSpent: true })]).status).toBe('done');
  });

  it('says pending when any page read says the server is still filing', () => {
    expect(joinPages([more(NAME_ROWS), page([], { pending: true })]).pending).toBe(true);
    expect(joinPages([page(NAME_ROWS)]).pending).toBe(false);
  });
});
