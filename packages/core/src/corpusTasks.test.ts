import { describe, expect, it } from 'vitest';

import { REVIEW_REASONS } from './confidence';
import {
  CORPUS_NOT_RECORDED,
  CORPUS_REASON_LANE,
  CORPUS_TASK_FACETS,
  CORPUS_TASK_LANES,
} from './corpusTasks';

describe('the Corpus tasks vocabulary (B01-6a)', () => {
  it('builds two lanes, and leaves Contested as water out rather than reserving it (D306)', () => {
    expect([...CORPUS_TASK_LANES]).toEqual(['nameConflicts', 'classConflicts']);
    expect(CORPUS_TASK_LANES as readonly string[]).not.toContain('contested');
  });

  it('maps each filed reason to a lane, one reason a lane, and files no dissent in 6a', () => {
    const lanes = Object.values(CORPUS_REASON_LANE);
    expect(new Set(lanes).size).toBe(lanes.length);
    expect([...lanes].sort()).toEqual([...CORPUS_TASK_LANES].sort());
    for (const reason of Object.keys(CORPUS_REASON_LANE)) {
      expect(REVIEW_REASONS as readonly string[]).toContain(reason);
    }
    expect(Object.keys(CORPUS_REASON_LANE)).not.toContain('class-dissent');
  });

  it('gives every lane its facets, `notRecorded` only where facts can be missing', () => {
    expect(Object.keys(CORPUS_TASK_FACETS).sort()).toEqual([...CORPUS_TASK_LANES].sort());
    // Names have been stored since A07a; class claims only since B01-3d.
    expect(CORPUS_TASK_FACETS.nameConflicts as readonly string[]).not.toContain(
      CORPUS_NOT_RECORDED,
    );
    expect(CORPUS_TASK_FACETS.classConflicts.at(-1)).toBe(CORPUS_NOT_RECORDED);
    for (const facets of Object.values(CORPUS_TASK_FACETS)) {
      expect(facets as readonly string[]).not.toContain('all');
    }
  });
});
