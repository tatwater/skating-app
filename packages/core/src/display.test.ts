import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  curatedBoostIsRedundant,
  DISPLAY_AREA_MAX_SQM,
  DISPLAY_AREA_MIN_SQM,
  displayScore,
  MIN_VISIBLE_ZOOM_FLOOR,
  MIN_VISIBLE_ZOOM_WIDEST,
  minVisibleZoom,
  type ProfileRichness,
  profileRichness,
  RICHNESS_STATIC_CAP,
  RICHNESS_TOTAL_CAP,
  SCORE_PER_ZOOM_LEVEL,
} from './display';

describe('displayScore (D49)', () => {
  it('maps the area reference bounds to [0, 1]', () => {
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MIN_SQM })).toBe(0);
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MAX_SQM })).toBe(1);
  });

  it('clamps the area term outside the reference bounds', () => {
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MIN_SQM / 10 })).toBe(0);
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MAX_SQM * 10 })).toBe(1);
  });

  it('treats missing / invalid area as the minimum (lowest prominence)', () => {
    expect(displayScore({})).toBe(0);
    expect(displayScore({ surfaceAreaSqM: 0 })).toBe(0);
    expect(displayScore({ surfaceAreaSqM: -5 })).toBe(0);
    expect(displayScore({ surfaceAreaSqM: Number.NaN })).toBe(0);
    expect(displayScore({ surfaceAreaSqM: Number.POSITIVE_INFINITY })).toBe(0);
  });

  it('adds curatedBoost directly (can exceed 1 to force wider)', () => {
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MIN_SQM, curatedBoost: 0.5 })).toBe(0.5);
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MAX_SQM, curatedBoost: 0.5 })).toBe(1.5);
  });

  it('is monotonic non-decreasing in area (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        (a, b) => {
          const [smaller, larger] = a <= b ? [a, b] : [b, a];
          expect(displayScore({ surfaceAreaSqM: larger })).toBeGreaterThanOrEqual(
            displayScore({ surfaceAreaSqM: smaller }),
          );
        },
      ),
    );
  });
});

describe('minVisibleZoom (D49)', () => {
  it('maps score 0 to the floor and score 1 to the widest', () => {
    expect(minVisibleZoom(0)).toBe(MIN_VISIBLE_ZOOM_FLOOR);
    expect(minVisibleZoom(1)).toBe(MIN_VISIBLE_ZOOM_WIDEST);
  });

  it('clamps scores outside [0, 1]', () => {
    expect(minVisibleZoom(-3)).toBe(MIN_VISIBLE_ZOOM_FLOOR);
    expect(minVisibleZoom(5)).toBe(MIN_VISIBLE_ZOOM_WIDEST);
  });

  it('returns an integer within the bucket range (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 5, noNaN: true }), (score) => {
        const z = minVisibleZoom(score);
        expect(Number.isInteger(z)).toBe(true);
        expect(z).toBeGreaterThanOrEqual(MIN_VISIBLE_ZOOM_WIDEST);
        expect(z).toBeLessThanOrEqual(MIN_VISIBLE_ZOOM_FLOOR);
      }),
    );
  });

  it('is monotonic non-increasing in score (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        (a, b) => {
          const [lower, higher] = a <= b ? [a, b] : [b, a];
          expect(minVisibleZoom(higher)).toBeLessThanOrEqual(minVisibleZoom(lower));
        },
      ),
    );
  });
});

describe('displayScore → minVisibleZoom (D49 end-to-end)', () => {
  it('a bigger body draws at an equal-or-wider zoom (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        (a, b) => {
          const [smaller, larger] = a <= b ? [a, b] : [b, a];
          const zSmall = minVisibleZoom(displayScore({ surfaceAreaSqM: smaller }));
          const zLarge = minVisibleZoom(displayScore({ surfaceAreaSqM: larger }));
          expect(zLarge).toBeLessThanOrEqual(zSmall);
        },
      ),
    );
  });

  it('curatedBoost raises prominence (never draws narrower)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (area, boost) => {
          const base = minVisibleZoom(displayScore({ surfaceAreaSqM: area }));
          const boosted = minVisibleZoom(
            displayScore({ surfaceAreaSqM: area, curatedBoost: boost }),
          );
          expect(boosted).toBeLessThanOrEqual(base);
        },
      ),
    );
  });

  it('every body is visible by the floor zoom regardless of score (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e12, noNaN: true }),
        fc.double({ min: -1, max: 3, noNaN: true }),
        (surfaceAreaSqM, curatedBoost) => {
          expect(
            minVisibleZoom(displayScore({ surfaceAreaSqM, curatedBoost })),
          ).toBeLessThanOrEqual(MIN_VISIBLE_ZOOM_FLOOR);
        },
      ),
    );
  });
});

describe('profile richness (N6c / D2)', () => {
  it('is a boost and never a penalty — an empty body scores exactly as before', () => {
    // The founder's stated worry: "I'd hate to not have a body someone cares about". Implementing
    // this as a subtraction would push already-obscure ponds below the discoverability floor.
    const bare = displayScore({ surfaceAreaSqM: 50_000 });
    expect(displayScore({ surfaceAreaSqM: 50_000, richness: {} })).toBe(bare);
    expect(displayScore({ surfaceAreaSqM: 50_000, richness: undefined })).toBe(bare);
    expect(profileRichness(undefined)).toBe(0);
    expect(profileRichness({})).toBe(0);
  });

  it('sits on the real 0-1 scale, not the plan’s +1..+4', () => {
    // The plan's table summed to +13 against a score whose whole dynamic range is 1.0. A "+1 for a
    // name" would have pushed every named body to the widest zoom bucket with all tests passing.
    const everything: ProfileRichness = {
      hasName: true,
      hasDepth: true,
      hasContours: true,
      hasOfficialPutIn: true,
      hasActivity: true,
    };
    expect(profileRichness(everything)).toBeLessThanOrEqual(RICHNESS_TOTAL_CAP);
    // At most ~3.2 zoom levels of movement, against a curated boost's ~2.4.
    expect(profileRichness(everything) / SCORE_PER_ZOOM_LEVEL).toBeLessThan(4);
    expect(profileRichness({ hasName: true }) / SCORE_PER_ZOOM_LEVEL).toBeLessThan(0.25);
  });

  it('lets activity alone match a curated boost, but not metadata alone', () => {
    // Founder call: real-world documentation should retire hand-curation. Metadata says a body is
    // documented; only activity says somebody wanted to skate it.
    const CURATED = 0.3;
    expect(profileRichness({ hasActivity: true })).toBeGreaterThanOrEqual(CURATED);
    expect(
      profileRichness({
        hasName: true,
        hasDepth: true,
        hasContours: true,
        hasOfficialPutIn: true,
      }),
    ).toBeLessThan(CURATED);
  });

  it('does not pay twice for one put-in fact', () => {
    // `official` supersedes `derived`; they are two rungs of "you can get on the ice here".
    const both = profileRichness({ hasDerivedPutIn: true, hasOfficialPutIn: true });
    expect(both).toBe(profileRichness({ hasOfficialPutIn: true }));
    expect(both).toBeGreaterThan(profileRichness({ hasDerivedPutIn: true }));
  });

  it('caps the static half below a curated boost and the total above it', () => {
    expect(RICHNESS_STATIC_CAP).toBeLessThan(0.3);
    expect(RICHNESS_TOTAL_CAP).toBeGreaterThan(0.3);
  });

  it('is monotonic: knowing more never lowers a score', () => {
    fc.assert(
      fc.property(
        fc.record({
          hasName: fc.boolean(),
          hasDepth: fc.boolean(),
          hasContours: fc.boolean(),
          hasDerivedPutIn: fc.boolean(),
          hasOfficialPutIn: fc.boolean(),
          hasActivity: fc.boolean(),
        }),
        fc.constantFrom<keyof ProfileRichness>('hasName', 'hasDepth', 'hasContours', 'hasActivity'),
        (base, key) => {
          const before = profileRichness({ ...base, [key]: false });
          const after = profileRichness({ ...base, [key]: true });
          expect(after).toBeGreaterThanOrEqual(before);
        },
      ),
    );
  });

  it('never moves a body below its un-enriched zoom bucket', () => {
    fc.assert(
      fc.property(fc.double({ min: 100, max: 1e9, noNaN: true }), (surfaceAreaSqM) => {
        const bare = minVisibleZoom(displayScore({ surfaceAreaSqM }));
        const rich = minVisibleZoom(
          displayScore({ surfaceAreaSqM, richness: { hasActivity: true, hasName: true } }),
        );
        expect(rich).toBeLessThanOrEqual(bare); // lower zoom number = visible from wider out
      }),
    );
  });
});

describe('curatedBoostIsRedundant (the D2 retirement signal)', () => {
  it('flags a boost a body has now earned on its own', () => {
    // Curated boosts are a cold-start seed with a retirement path, not a permanent registry.
    expect(curatedBoostIsRedundant(0.3, { hasActivity: true })).toBe(true);
  });

  it('does not flag one that is still doing work', () => {
    expect(curatedBoostIsRedundant(0.3, { hasName: true, hasDepth: true })).toBe(false);
    expect(curatedBoostIsRedundant(0.3, undefined)).toBe(false);
  });

  it('says nothing about a body with no boost to retire', () => {
    expect(curatedBoostIsRedundant(undefined, { hasActivity: true })).toBe(false);
    expect(curatedBoostIsRedundant(0, { hasActivity: true })).toBe(false);
    // A negative boost is a deliberate demotion, not a seed — never "redundant".
    expect(curatedBoostIsRedundant(-0.2, { hasActivity: true })).toBe(false);
  });
});
