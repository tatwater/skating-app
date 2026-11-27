import { describe, expect, test } from 'vitest';
import { parseNaipItemId } from './naipCatalog';
import { NAIP_CLOUD_KEPT, NAIP_EXCLUSIONS, NAIP_FOLIAGE_STRIKES } from './naipExclusions';
import { isNaipFlightStrike, naipFoliageStruck } from './naipSelection';

describe('the committed lists', () => {
  test("the founder's first review struck the two Aroostook cumulus frames and nothing else", () => {
    expect(NAIP_EXCLUSIONS.map((e) => [e.itemId, e.reason, e.reviewedBy, e.reviewedOn])).toEqual([
      ['me_m_4606741_se_19_030_20230922_20240103', 'cloud', 'founder', '2026-11-25'],
      ['me_m_4606741_ne_19_030_20230922_20240103', 'cloud', 'founder', '2026-11-25'],
    ]);
  });

  test('every exclusion is reviewed, with a reason and a day', () => {
    for (const ex of NAIP_EXCLUSIONS) {
      expect(['cloud', 'glare']).toContain(ex.reason);
      expect(['founder', 'builder']).toContain(ex.reviewedBy);
      expect(ex.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(new Set(NAIP_EXCLUSIONS.map((e) => e.itemId)).size).toBe(NAIP_EXCLUSIONS.length);
  });

  test('the cloud review kept 23 Long Island and New York City picks, none of them struck', () => {
    expect(NAIP_CLOUD_KEPT).toHaveLength(23);
    expect(new Set(NAIP_CLOUD_KEPT).size).toBe(23);
    for (const id of NAIP_CLOUD_KEPT)
      expect(id).toMatch(/^ny_m_400\d{4}_(ne|nw|se|sw)_18_060_2024/);
    const struck = new Set(NAIP_EXCLUSIONS.map((e) => e.itemId));
    expect(NAIP_CLOUD_KEPT.filter((id) => struck.has(id))).toEqual([]);
  });

  test('every foliage strike is confirmed by the founder, never a proposal', () => {
    for (const s of NAIP_FOLIAGE_STRIKES) {
      expect(s.reviewedBy).toBe('founder');
      expect(s.reason).toBe('turned');
      expect(s.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (isNaipFlightStrike(s)) {
        expect(s.flight.acquired).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect([...s.keep].sort()).toEqual(s.keep);
      }
    }
  });

  test('no foliage strike takes a frame the cloud review kept on purpose', () => {
    const turned = naipFoliageStruck(NAIP_FOLIAGE_STRIKES);
    // The id read by core's one reader: its first date is the flight's (a second is processing).
    for (const id of NAIP_CLOUD_KEPT) {
      const { acquired } = parseNaipItemId(id);
      expect(turned({ itemId: id, state: 'NY', acquired })).toBe(false);
    }
  });
});
