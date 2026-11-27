import { describe, expect, it } from 'vitest';

import * as words from './machineryWords';
import { countName, laneTailWords, passesWords, scopeWords, zeroLine } from './machineryWords';

const NOW = Date.UTC(2026, 9, 12, 18, 12);

describe('the sidebar’s tail', () => {
  it.each([
    ['stalled', 'stalled', 'bad'],
    ['failed', 'failed', 'bad'],
    ['late', 'late', 'warn'],
    ['waiting', 'waiting', 'warn'],
    ['notRecorded', 'no heartbeat', 'warn'],
    ['running', 'running', 'lit'],
    ['never', 'not run', 'default'],
  ] as const)('words %s', (state, word, tone) => {
    expect(laneTailWords(state, NOW, NOW)).toEqual({ word, tone });
  });

  it('says ok and how long ago, and ok alone with no time', () => {
    expect(laneTailWords('ok', NOW - 2 * 60_000, NOW)).toEqual({
      word: 'ok 2 min',
      tone: 'default',
    });
    expect(laneTailWords('finished', null, NOW)).toEqual({ word: 'ok', tone: 'default' });
  });
});

describe('Inbox Zero’s line', () => {
  it('speaks only when a run needs a person', () => {
    expect(zeroLine('stalled')).toBe('1 run stalled');
    expect(zeroLine('waiting')).toBe('1 run stalled, waited on');
    expect(zeroLine('late')).toBe('1 run late');
    expect(zeroLine('failed')).toBe('The last run failed');
    expect(zeroLine('notRecorded')).toBe('1 run with no heartbeat');
    for (const quiet of ['running', 'ok', 'never', 'finished']) expect(zeroLine(quiet)).toBeNull();
  });
});

describe('the sub-line’s pieces', () => {
  it('writes passes against the plan, or alone when the plan wasn’t kept', () => {
    expect(passesWords(2, 10)).toBe('2 of 10 passes');
    expect(passesWords(1, null)).toBe('1 pass');
    expect(passesWords(1_200, null)).toBe('1,200 passes');
  });

  it('turns a stored count’s name into words', () => {
    expect(countName('placeNamesQueued')).toBe('place names queued');
    expect(countName('rows_folded')).toBe('rows folded');
    expect(countName('batches-applied')).toBe('batches applied');
  });

  it('writes the scope, its states only when it wasn’t the whole corpus', () => {
    expect(scopeWords({ pass: 'full-canonical', states: ['VT', 'NH'], complete: true })).toBe(
      'Full canonical',
    );
    expect(scopeWords({ pass: 'one-state', states: ['VT'], complete: false })).toBe(
      'One state · VT',
    );
    expect(scopeWords({ pass: 'one-state', states: [], complete: false })).toBe('One state');
    expect(scopeWords({ pass: '', states: null, complete: false })).toBe('Not recorded');
  });

  it('counts the list’s end honestly before the history is indexed', () => {
    expect(words.allRuns(41)).toBe('All 41');
    expect(words.listedSoFar(3)).toBe('3 listed so far');
    expect(words.bodiesLoaded(1)).toBe('1 body loaded');
    expect(words.stoppedAt('merge')).toBe('Stopped at merge');
    expect(words.headlineWords('rowsDemoted', 412)).toBe('412 rows demoted');
  });
});

describe('the words themselves', () => {
  it('say nothing about the ice, and carry no decision numbers or section marks', () => {
    const all = Object.values(words)
      .flatMap((w) => (typeof w === 'string' ? [w] : typeof w === 'object' ? Object.values(w) : []))
      .join(' ');
    expect(all).not.toMatch(/\bsafe\b|skateable|good to go|\bD\d+\b|§/i);
  });
});
