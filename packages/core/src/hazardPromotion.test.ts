import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HAZARD_DECAY } from './hazardDecay';
import {
  type PromotionCandidate,
  promotionPriority,
  promotionTargetFor,
  rankPromotionCandidates,
} from './hazardPromotion';
import { HAZARD_TYPES, type HazardType } from './types';

const arbType: fc.Arbitrary<HazardType> = fc.constantFrom(...HAZARD_TYPES);
const arbCandidate: fc.Arbitrary<PromotionCandidate> = fc.record({
  type: arbType,
  confirmCount: fc.integer({ min: 0, max: 20 }),
  goneCount: fc.integer({ min: 0, max: 20 }),
});

describe('promotionTargetFor', () => {
  it('offers nothing for the volatile types — an event is not a fixture', () => {
    // A permanent marker on open water would be a standing warning nobody can ever clear.
    expect(promotionTargetFor('open_water')).toBeNull();
    expect(promotionTargetFor('thin_ice')).toBeNull();
    expect(promotionTargetFor('overflow_slush')).toBeNull();
  });

  it('maps the fixed-cause types to their permanent equivalents', () => {
    expect(promotionTargetFor('spring_current')).toBe('spring_current');
    expect(promotionTargetFor('gas_hole')).toBe('gas_hole');
    expect(promotionTargetFor('reef_hole')).toBe('reef_hole');
    // Named for the pattern, not for a ridge that is there right now.
    expect(promotionTargetFor('pressure_ridge')).toBe('recurring_pressure_ridge');
  });

  it('never invents a target for a passage marker — a crossing is not a lake feature', () => {
    expect(promotionTargetFor('ridge_crossing')).toBeNull();
  });
});

describe('promotionPriority', () => {
  it('scores an unpromotable type at exactly zero, however corroborated', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (confirmCount) => {
        expect(promotionPriority({ type: 'open_water', confirmCount, goneCount: 0 })).toBe(0);
      }),
    );
  });

  it('stays in [0, 1] for every input', () => {
    fc.assert(
      fc.property(arbCandidate, (candidate) => {
        const score = promotionPriority(candidate);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('ranks the permanent behavior above the structural one at equal corroboration', () => {
    const permanent = promotionPriority({ type: 'spring_current', confirmCount: 1, goneCount: 0 });
    const structural = promotionPriority({ type: 'pressure_ridge', confirmCount: 1, goneCount: 0 });
    expect(HAZARD_DECAY.spring_current.tier).toBe('D');
    expect(HAZARD_DECAY.pressure_ridge.tier).toBe('C');
    expect(permanent).toBeGreaterThan(structural);
  });

  it('rises with corroboration and falls with contradiction', () => {
    const base = { type: 'pressure_ridge' as const, confirmCount: 0, goneCount: 0 };
    expect(promotionPriority({ ...base, confirmCount: 2 })).toBeGreaterThan(
      promotionPriority(base),
    );
    expect(promotionPriority({ ...base, goneCount: 2 })).toBeLessThan(promotionPriority(base));
  });

  it('is monotonic in confirmations — more evidence never demotes a candidate', () => {
    fc.assert(
      fc.property(arbType, fc.integer({ min: 0, max: 10 }), (type, confirmCount) => {
        const less = promotionPriority({ type, confirmCount, goneCount: 0 });
        const more = promotionPriority({ type, confirmCount: confirmCount + 1, goneCount: 0 });
        expect(more).toBeGreaterThanOrEqual(less);
      }),
    );
  });

  it('caps corroboration — the count answers "was it real", not "how permanent"', () => {
    const three = promotionPriority({ type: 'gas_hole', confirmCount: 3, goneCount: 0 });
    const thirty = promotionPriority({ type: 'gas_hole', confirmCount: 30, goneCount: 0 });
    expect(thirty).toBe(three);
  });
});

describe('rankPromotionCandidates', () => {
  it('drops what cannot be promoted and orders the rest most-promotable first', () => {
    const ranked = rankPromotionCandidates([
      { id: 'ridge', type: 'pressure_ridge' as const, confirmCount: 0, goneCount: 0 },
      { id: 'lead', type: 'open_water' as const, confirmCount: 9, goneCount: 0 },
      { id: 'spring', type: 'spring_current' as const, confirmCount: 0, goneCount: 0 },
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['spring', 'ridge']);
  });

  it('keeps the caller’s order for ties, so equal candidates stay newest-first', () => {
    const ranked = rankPromotionCandidates([
      { id: 'older', type: 'gas_hole' as const, confirmCount: 1, goneCount: 0 },
      { id: 'newer', type: 'gas_hole' as const, confirmCount: 1, goneCount: 0 },
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['older', 'newer']);
  });

  it('returns an empty list rather than a low-confidence one when nothing qualifies', () => {
    // The pass is a safety task; padding it with events that cannot recur would waste the attention
    // it exists to direct.
    expect(rankPromotionCandidates([{ type: 'thin_ice', confirmCount: 5, goneCount: 0 }])).toEqual(
      [],
    );
  });
});
