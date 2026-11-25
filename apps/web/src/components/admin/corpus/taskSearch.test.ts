import { CORPUS_TASK_FACETS, CORPUS_TASK_LANES } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { validateBodiesSearch } from '../bodies/bodiesSearch';
import { taskId } from './corpusFixtures';
import { TASK_LANE_LIST, TASK_LANES, taskLaneById } from './taskLanes';
import {
  isBodyRef,
  placeAfter,
  type TaskQuery,
  taskItemOf,
  taskListKey,
  taskQueryOf,
  taskSearchFor,
  taskTabOf,
} from './taskSearch';

const ID = taskId('basin');
const BODY = 'k17bodybasin00000000000000000000';
const names = TASK_LANES.nameConflicts;
const classes = TASK_LANES.classConflicts;

describe('the task lanes, as data', () => {
  it('have an entry for every lane core builds, in core order, under Tasks', () => {
    expect(TASK_LANE_LIST.map((l) => [l.task, l.id, l.group, l.label])).toEqual([
      ['nameConflicts', 'name-conflicts', 'Tasks', 'Name conflicts'],
      ['classConflicts', 'class-conflicts', 'Tasks', 'Class conflicts'],
    ]);
    expect(TASK_LANE_LIST.map((l) => l.task)).toEqual([...CORPUS_TASK_LANES]);
  });

  it('draw a tab for every facet but notRecorded, in core order, with the boards’ words', () => {
    expect(names.tabs).toEqual([
      { id: 'different', label: 'Different' },
      { id: 'oneLetter', label: 'One letter' },
      { id: 'qualifier', label: 'Qualifier' },
    ]);
    expect(classes.tabs).toEqual([
      { id: 'wetlandOrLake', label: 'Wetland or lake' },
      { id: 'otherPairs', label: 'Other pairs' },
    ]);
    for (const lane of TASK_LANE_LIST) {
      expect(lane.tabs.map((t) => t.id)).toEqual(
        CORPUS_TASK_FACETS[lane.task].filter((f) => f !== 'notRecorded'),
      );
    }
  });

  it('resolve a URL id to its lane, and nothing else', () => {
    expect(taskLaneById('name-conflicts')).toBe(names);
    expect(taskLaneById('class-conflicts')).toBe(classes);
    // Not built in 6a (D307), a library lane, the server's own name, junk.
    for (const id of ['contested', 'duplicates', 'active', 'nameConflicts', '', undefined]) {
      expect(taskLaneById(id)).toBeNull();
    }
  });
});

describe('a task lane’s tab and item', () => {
  it('keeps a tab the lane has, or decided; drops notRecorded, another lane’s and junk', () => {
    expect(taskTabOf(names, 'oneLetter')).toBe('oneLetter');
    expect(taskTabOf(names, 'decided')).toBe('decided');
    expect(taskTabOf(classes, 'notRecorded')).toBeNull();
    expect(taskTabOf(classes, 'oneLetter')).toBeNull();
    expect(taskTabOf(names, 'All')).toBeNull();
    expect(taskTabOf(names, 3)).toBeNull();
  });

  it('keeps a task id or body:<id>, and drops anything else', () => {
    expect(taskItemOf(ID)).toBe(ID);
    expect(taskItemOf(` ${ID} `)).toBe(ID);
    expect(taskItemOf(`body:${BODY}`)).toBe(`body:${BODY}`);
    expect(isBodyRef(`body:${BODY}`)).toBe(true);
    expect(isBodyRef(ID)).toBe(false);
    for (const junk of ['pattern:abc', `hazard:${BODY}`, 'body:', 'body:short', 'x', 12, null]) {
      expect(taskItemOf(junk)).toBeNull();
    }
  });

  it('reads the place with every default filled in, and writes it back with none', () => {
    const query = taskQueryOf({ lane: 'name-conflicts', tab: 'qualifier', item: ID, q: 123 });
    expect(query).toEqual({ lane: names, tab: 'qualifier', item: ID, q: '123' });
    expect(taskSearchFor(query as TaskQuery)).toEqual({
      lane: 'name-conflicts',
      tab: 'qualifier',
      item: ID,
      q: '123',
    });
    expect(taskSearchFor({ lane: names, tab: null, item: null, q: '  ' })).toEqual({
      lane: 'name-conflicts',
    });
    expect(taskQueryOf({ lane: 'active' })).toBeNull();
    expect(taskQueryOf({})).toBeNull();
  });

  it('closes a task opened from the list when the list changes, and keeps one that came by a link', () => {
    const at: TaskQuery = { lane: names, tab: null, item: ID, q: '' };
    const tabbed: TaskQuery = { ...at, tab: 'different' };
    expect(placeAfter(at, tabbed, true).item).toBeNull();
    expect(placeAfter(at, tabbed, false).item).toBe(ID);
    // The same list: nothing moves.
    expect(placeAfter(at, { ...at }, true).item).toBe(ID);
    expect(taskListKey(at)).not.toBe(taskListKey(tabbed));
    expect(taskListKey(at)).toBe(taskListKey({ ...at, item: null }));
  });
});

describe('the route’s search, with task lanes', () => {
  it('keeps a task lane with its tab and item, and drops the library’s fields on it', () => {
    expect(
      validateBodiesSearch({
        lane: 'name-conflicts',
        tab: 'oneLetter',
        item: ID,
        q: 'basin',
        body: BODY,
        state: 'nh',
        sort: 'acres',
        dir: 'asc',
        size: '1000-up',
      }),
    ).toEqual({ lane: 'name-conflicts', tab: 'oneLetter', item: ID, q: 'basin' });
  });

  it('drops a tab the lane hasn’t, an item that names nothing, and a lane not built', () => {
    expect(
      validateBodiesSearch({ lane: 'class-conflicts', tab: 'notRecorded', item: 'hazard:x' }),
    ).toEqual({ lane: 'class-conflicts' });
    expect(validateBodiesSearch({ lane: 'class-conflicts', tab: 'different' })).toEqual({
      lane: 'class-conflicts',
    });
    // The Overview's old `?task=`, and a lane 6a doesn't build: the library's default.
    expect(validateBodiesSearch({ task: 'nameConflicts' })).toEqual({});
    expect(validateBodiesSearch({ lane: 'contested', tab: 'decided' })).toEqual({});
  });

  it('drops a task lane’s tab and item on a library lane', () => {
    expect(validateBodiesSearch({ lane: 'removed', tab: 'decided', item: ID, q: 'x' })).toEqual({
      lane: 'removed',
      q: 'x',
    });
  });
});
