import { describe, expect, it } from 'vitest';

import { CLASS_ROWS, NAME_DECIDED_ROW, NAME_ROWS, page } from '../corpusFixtures';
import type { CorpusListPage } from '../corpusTypes';
import { decidedStateOf } from '../inspector/corpusLock';
import { acresText } from '../words/corpusWords';
import { joinPages } from './taskReads';
import { taskRowView } from './taskRows';

const [basin, , , , crystal] = NAME_ROWS;
const [hatch, , ossipee] = CLASS_ROWS;

describe('a task row, as the list draws it', () => {
  it('a name conflict: the shown name, then the other and where, and its acres', () => {
    expect(taskRowView(basin as (typeof NAME_ROWS)[number])).toEqual({
      id: basin?.taskId,
      title: 'The Basin',
      sub: '/ Lake Auburn · Auburn, ME',
      acres: '2,263 ac',
      done: false,
    });
    // No acres recorded: none drawn, never a zero.
    expect(taskRowView(crystal as (typeof NAME_ROWS)[number]).acres).toBeNull();
  });

  it('a class conflict: the body, then what the catalogs say — or that it isn’t recorded', () => {
    expect(taskRowView(hatch as (typeof CLASS_ROWS)[number]).sub).toBe(
      'OSM Lake or pond · NHD Wetland · Eaton, NH',
    );
    expect(taskRowView(ossipee as (typeof CLASS_ROWS)[number]).sub).toBe(
      'Not recorded · Ossipee, NH',
    );
  });

  it('a decided row says what was decided and by whom first', () => {
    const row = taskRowView(NAME_DECIDED_ROW);
    expect(row.done).toBe(true);
    expect(row.sub).toBe('renamed · by Avery Lindqvist · / Dublin Pond · Dublin, NH');
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
