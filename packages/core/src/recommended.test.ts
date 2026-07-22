import { describe, expect, it } from 'vitest';
import {
  isRecommendable,
  type RecommendableReport,
  rankRecommendations,
  selectRecommended,
} from './recommended';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** A report that clears every clause of the exceptional bar — tests knock out one dimension at a time. */
function passing(overrides: Partial<RecommendableReport> = {}): RecommendableReport {
  return {
    reportId: 'r1',
    waterBodyId: 'b1',
    skateEndTime: NOW - HOUR,
    skateQuality: 'great',
    iceTypes: ['black_ice'],
    photoCount: 2,
    corroborationCount: 3,
    authorTrust: 'expert',
    ...overrides,
  };
}

describe('isRecommendable', () => {
  it('accepts a report that clears every clause', () => {
    expect(isRecommendable(passing(), NOW)).toBe(true);
    expect(isRecommendable(passing({ authorTrust: 'leader' }), NOW)).toBe(true);
  });

  it('rejects when any single clause fails', () => {
    expect(isRecommendable(passing({ corroborationCount: 2 }), NOW)).toBe(false);
    expect(isRecommendable(passing({ authorTrust: 'trusted' }), NOW)).toBe(false);
    expect(isRecommendable(passing({ authorTrust: null }), NOW)).toBe(false);
    expect(isRecommendable(passing({ photoCount: 1 }), NOW)).toBe(false);
    expect(isRecommendable(passing({ skateQuality: 'good' }), NOW)).toBe(false);
    expect(isRecommendable(passing({ skateQuality: undefined }), NOW)).toBe(false);
    expect(isRecommendable(passing({ iceTypes: ['white_ice'] }), NOW)).toBe(false);
    expect(isRecommendable(passing({ iceTypes: undefined }), NOW)).toBe(false);
    expect(isRecommendable(passing({ skateEndTime: NOW - 49 * HOUR }), NOW)).toBe(false);
  });

  it('honors threshold overrides', () => {
    expect(isRecommendable(passing({ photoCount: 1 }), NOW, { minPhotos: 1 })).toBe(true);
    expect(
      isRecommendable(passing({ authorTrust: 'trusted' }), NOW, { minTrustClass: 'trusted' }),
    ).toBe(true);
  });
});

describe('rankRecommendations', () => {
  it('orders by corroboration, then photos, then recency', () => {
    const a = passing({ reportId: 'a', corroborationCount: 5 });
    const b = passing({ reportId: 'b', corroborationCount: 3, photoCount: 4 });
    const c = passing({ reportId: 'c', corroborationCount: 3, photoCount: 2, skateEndTime: NOW });
    const d = passing({
      reportId: 'd',
      corroborationCount: 3,
      photoCount: 2,
      skateEndTime: NOW - HOUR,
    });
    expect(rankRecommendations([d, c, b, a]).map((r) => r.reportId)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('selectRecommended', () => {
  it('bundles the top reports per body and caps unique bodies', () => {
    const candidates = [
      passing({ reportId: 'b1r1', waterBodyId: 'b1', corroborationCount: 6 }),
      passing({ reportId: 'b1r2', waterBodyId: 'b1', corroborationCount: 5 }),
      passing({ reportId: 'b1r3', waterBodyId: 'b1', corroborationCount: 4 }),
      passing({ reportId: 'b2r1', waterBodyId: 'b2', corroborationCount: 3 }),
      passing({ reportId: 'b3r1', waterBodyId: 'b3', corroborationCount: 3 }),
    ];
    const cards = selectRecommended(candidates, { now: NOW });
    expect(cards).toEqual([
      { waterBodyId: 'b1', reportIds: ['b1r1', 'b1r2'] }, // bundle top-2, best first
      { waterBodyId: 'b2', reportIds: ['b2r1'] },
    ]); // b3 dropped by the ≤2-bodies daily cap
  });

  it('excludes recently-recommended bodies (dedup)', () => {
    const candidates = [
      passing({ reportId: 'b1r1', waterBodyId: 'b1' }),
      passing({ reportId: 'b2r1', waterBodyId: 'b2' }),
    ];
    const cards = selectRecommended(candidates, { now: NOW, excludeBodyIds: new Set(['b1']) });
    expect(cards).toEqual([{ waterBodyId: 'b2', reportIds: ['b2r1'] }]);
  });

  it('drops non-recommendable candidates before selecting', () => {
    const cards = selectRecommended([passing({ corroborationCount: 1 })], { now: NOW });
    expect(cards).toEqual([]);
  });

  it('returns nothing when the daily budget is exhausted', () => {
    expect(selectRecommended([passing()], { now: NOW, maxBodies: 0 })).toEqual([]);
  });

  it('honors a custom bundle size', () => {
    const candidates = [
      passing({ reportId: 'r1', corroborationCount: 6 }),
      passing({ reportId: 'r2', corroborationCount: 5 }),
    ];
    expect(selectRecommended(candidates, { now: NOW, bundleSize: 1 })).toEqual([
      { waterBodyId: 'b1', reportIds: ['r1'] },
    ]);
  });
});
