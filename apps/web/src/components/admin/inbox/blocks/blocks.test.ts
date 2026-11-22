import { describe, expect, test } from 'vitest';

import { ROB_AUTHOR } from '../handlers/Flag/flagFixtures';
import {
  canPostWords,
  KNOWN_RESTRICTIONS,
  openFlagsWords,
  priorActionedWords,
  reportsWords,
} from './AuthorBlock';

describe('the author block’s words', () => {
  test('what they may post', () => {
    expect(canPostWords([])).toBe('reports · hazards · comments');
    expect(canPostWords(['comments', 'flagging'])).toBe('reports · hazards');
    expect(canPostWords(['reports', 'hazards', 'comments'])).toBe('Nothing');
    expect(KNOWN_RESTRICTIONS).toContain('reports');
  });
  test('reports and contradicted; unknown never reads as zero', () => {
    expect(reportsWords(ROB_AUTHOR)).toBe('14 · 2 flagged by the contradiction check');
    expect(reportsWords({ ...ROB_AUTHOR, contradicted: { count: 0, capped: false } })).toBe('14');
    expect(reportsWords({ ...ROB_AUTHOR, contradicted: null })).toBe('14');
    expect(reportsWords({ ...ROB_AUTHOR, reports: null })).toBe('Not recorded yet');
    expect(reportsWords({ ...ROB_AUTHOR, reports: { count: 400, capped: true } })).toBe(
      '400+ · 2 flagged by the contradiction check',
    );
  });
  test('open flags: "this one" only when they are all this item’s', () => {
    expect(openFlagsWords({ count: 1, capped: false }, 1)).toBe('1 · this one');
    expect(openFlagsWords({ count: 3, capped: false }, 1)).toBe('3');
    expect(openFlagsWords({ count: 1, capped: true }, 1)).toBe('1+');
    expect(openFlagsWords({ count: 0, capped: false }, 0)).toBe('0');
    expect(openFlagsWords(null, 1)).toBe('Not recorded yet');
  });
});

describe('earlier actioned flags', () => {
  test('one, many, a floor, none', () => {
    const day = new Date(2026, 9, 10, 12).getTime();
    expect(priorActionedWords({ count: 1, capped: false, lastAt: day })).toBe(
      'An earlier flag on them was actioned on Sat 10 Oct',
    );
    expect(priorActionedWords({ count: 3, capped: false, lastAt: day })).toBe(
      '3 earlier flags on them were actioned, the latest on Sat 10 Oct',
    );
    expect(priorActionedWords({ count: 50, capped: true, lastAt: null })).toBe(
      '50+ earlier flags on them were actioned',
    );
    expect(priorActionedWords({ count: 0, capped: false, lastAt: null })).toBeNull();
  });
  test('their reports, counted among their newest 100: the cap reads as a floor', () => {
    expect(reportsWords({ ...ROB_AUTHOR, reports: { count: 100, capped: true } })).toBe(
      '100+ · 2 flagged by the contradiction check',
    );
  });
});
