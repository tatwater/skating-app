import { describe, expect, test } from 'vitest';
import { NAIP_EXCLUSIONS, NAIP_OFF_SEASON_CELLS } from './naipExclusions';

describe('the committed lists', () => {
  test('the off-season cells are the six north of Rumford, and only those', () => {
    expect([...NAIP_OFF_SEASON_CELLS].sort()).toEqual([
      '4407004ne',
      '4407004se',
      '4407012ne',
      '4407020ne',
      '4407020se',
      '4407028ne',
    ]);
  });

  test('every off-season cell is a quarter-quad key', () => {
    for (const key of NAIP_OFF_SEASON_CELLS) expect(key).toMatch(/^\d{7}(ne|nw|se|sw)$/);
  });

  test('every exclusion is reviewed, with a reason and a day', () => {
    for (const ex of NAIP_EXCLUSIONS) {
      expect(['cloud', 'glare']).toContain(ex.reason);
      expect(['founder', 'builder']).toContain(ex.reviewedBy);
      expect(ex.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(new Set(NAIP_EXCLUSIONS.map((e) => e.itemId)).size).toBe(NAIP_EXCLUSIONS.length);
  });
});
