import { describe, expect, test } from 'vitest';

import { at, BOARD_ZONE, ROB_AUTHOR } from '../handlers/Flag/flagFixtures';
import {
  canPostWords,
  KNOWN_RESTRICTIONS,
  openFlagsWords,
  priorActionedWords,
  reportsWords,
} from './AuthorBlock';
import { appNoteShown } from './FlagBlock';

describe('the author block’s words', () => {
  test('what they may post', () => {
    expect(canPostWords([])).toBe('reports · hazards · comments');
    expect(canPostWords(['comments', 'flagging'])).toBe('reports · hazards');
    expect(canPostWords(['reports', 'hazards', 'comments'])).toBe('Nothing');
    expect(KNOWN_RESTRICTIONS).toContain('reports');
  });
  test('reports and contradicted; unknown never reads as zero', () => {
    expect(reportsWords(ROB_AUTHOR)).toBe('14 · 2 counted by the contradiction check');
    expect(reportsWords({ ...ROB_AUTHOR, contradicted: { count: 0, capped: false } })).toBe('14');
    expect(reportsWords({ ...ROB_AUTHOR, contradicted: null })).toBe('14');
    expect(reportsWords({ ...ROB_AUTHOR, reports: null })).toBe('Not recorded yet');
    expect(reportsWords({ ...ROB_AUTHOR, reports: { count: 400, capped: true } })).toBe(
      '400+ · 2 counted by the contradiction check',
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
    const day = at(10, 10, 12);
    expect(priorActionedWords({ count: 1, capped: false, lastAt: day }, BOARD_ZONE)).toBe(
      'An earlier flag on them was actioned on Sat 10 Oct',
    );
    expect(priorActionedWords({ count: 3, capped: false, lastAt: day }, BOARD_ZONE)).toBe(
      '3 earlier flags on them were actioned, the latest on Sat 10 Oct',
    );
    expect(priorActionedWords({ count: 50, capped: true, lastAt: null }, BOARD_ZONE)).toBe(
      '50+ earlier flags on them were actioned',
    );
    expect(priorActionedWords({ count: 0, capped: false, lastAt: null }, BOARD_ZONE)).toBeNull();
  });
  test('their reports, counted among their newest 100: the cap reads as a floor', () => {
    expect(reportsWords({ ...ROB_AUTHOR, reports: { count: 100, capped: true } })).toBe(
      '100+ · 2 counted by the contradiction check',
    );
  });
});

describe('which app notes are drawn', () => {
  const app = { autoFiled: true, reason: 'unsafe_false_report' as const };
  test('the hazard vote’s own count, yes; the contradiction check’s prose and a missing note, no', () => {
    expect(
      appNoteShown(
        { ...app, note: '2 skaters reported that nothing was ever at this pin.' },
        'hazard',
      ),
    ).toBe(true);
    expect(
      appNoteShown(
        {
          ...app,
          note: 'Auto: repeated weather-unexplained contradictions against corroborated reports. Review the good-vs-bad trend.',
        },
        'user',
      ),
    ).toBe(false);
    expect(appNoteShown({ ...app, reason: 'auto_low_quality', note: null }, 'report')).toBe(false);
    // A person's words are the quote's, never this line's.
    expect(appNoteShown({ ...app, autoFiled: false, note: 'x' }, 'hazard')).toBe(false);
  });
});
