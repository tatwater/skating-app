import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEPTH_SOURCE_LABELS,
  DEPTH_SOURCE_RANK,
  DEPTH_SOURCES,
  type DepthCandidate,
  type DepthSource,
  describeLakeDepth,
  isMeasuredDepthSource,
  isShallowDepth,
  resolveDepth,
  SHALLOW_MAX_DEPTH_M,
  SHALLOW_MEAN_DEPTH_M,
} from './lakeDepth';

const arbSource = fc.constantFrom(...DEPTH_SOURCES);

describe('the depth source ladder (D68)', () => {
  it('ranks every source, uniquely, from the array order', () => {
    const ranks = DEPTH_SOURCES.map((s) => DEPTH_SOURCE_RANK[s]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(DEPTH_SOURCES.length);
  });

  it('puts the operator override above every automated source', () => {
    for (const source of DEPTH_SOURCES) {
      if (source === 'operator') continue;
      expect(DEPTH_SOURCE_RANK.operator).toBeLessThan(DEPTH_SOURCE_RANK[source]);
    }
  });

  it('ranks measured sources above the modelled ones — the point of the ladder', () => {
    // `osm_tag` is the deliberate exception: measured by someone, but with an unverifiable datum and
    // near-zero inland coverage, so it sits last. Every OTHER measured source outranks every model.
    const modelled = DEPTH_SOURCES.filter((s) => !isMeasuredDepthSource(s));
    const measured = DEPTH_SOURCES.filter((s) => isMeasuredDepthSource(s) && s !== 'osm_tag');
    for (const m of measured) {
      for (const g of modelled) {
        expect(DEPTH_SOURCE_RANK[m]).toBeLessThan(DEPTH_SOURCE_RANK[g]);
      }
    }
  });

  it('ranks a reported HydroLAKES volume above a modelled one', () => {
    expect(DEPTH_SOURCE_RANK.hydrolakes_reported).toBeLessThan(
      DEPTH_SOURCE_RANK.hydrolakes_modeled,
    );
  });

  it('classifies every source as measured or modelled, and labels every one', () => {
    for (const source of DEPTH_SOURCES) {
      expect(typeof isMeasuredDepthSource(source)).toBe('boolean');
      expect(DEPTH_SOURCE_LABELS[source]).toBeTruthy();
    }
  });

  it('treats no global source as measured (the D3 display split)', () => {
    for (const source of ['hydrolakes_reported', 'hydrolakes_modeled', 'globathy'] as const) {
      expect(isMeasuredDepthSource(source)).toBe(false);
    }
  });
});

describe('resolveDepth', () => {
  it('returns nothing for an empty candidate list', () => {
    expect(resolveDepth([])).toBeUndefined();
  });

  it('picks the best-ranked candidate regardless of input order', () => {
    const candidates: DepthCandidate[] = [
      { valueM: 4, source: 'globathy' },
      { valueM: 9, source: 'operator' },
      { valueM: 7, source: 'lagos_us' },
    ];
    expect(resolveDepth(candidates)).toEqual({ valueM: 9, source: 'operator' });
    expect(resolveDepth([...candidates].reverse())).toEqual({ valueM: 9, source: 'operator' });
  });

  it('drops non-positive and non-finite depths rather than ranking them', () => {
    // A 0 from these sources means "no measurement", not "a lake with no depth".
    expect(
      resolveDepth([
        { valueM: 0, source: 'operator' },
        { valueM: -3, source: 'state_agency' },
        { valueM: Number.NaN, source: 'lagos_us' },
        { valueM: Number.POSITIVE_INFINITY, source: 'hydrolakes_reported' },
        { valueM: 12, source: 'globathy' },
      ]),
    ).toEqual({ valueM: 12, source: 'globathy' });
  });

  it('keeps the first candidate on a rank tie (stable, not sort-dependent)', () => {
    expect(
      resolveDepth([
        { valueM: 5, source: 'lagos_us' },
        { valueM: 6, source: 'lagos_us' },
      ]),
    ).toEqual({ valueM: 5, source: 'lagos_us' });
  });

  it('property: the winner is always a usable candidate of minimal rank', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ valueM: fc.double({ min: -10, max: 400, noNaN: true }), source: arbSource }),
          { maxLength: 12 },
        ),
        (candidates) => {
          const usable = candidates.filter((c) => Number.isFinite(c.valueM) && c.valueM > 0);
          const winner = resolveDepth(candidates);
          if (usable.length === 0) {
            expect(winner).toBeUndefined();
            return;
          }
          expect(winner).toBeDefined();
          const bestRank = Math.min(
            ...usable.map((c) => DEPTH_SOURCE_RANK[c.source as DepthSource]),
          );
          expect(DEPTH_SOURCE_RANK[(winner as DepthCandidate).source]).toBe(bestRank);
          expect(usable).toContainEqual(winner);
        },
      ),
    );
  });
});

describe('isShallowDepth (D69)', () => {
  it('unknown depth is not shallow — absent data never applies the amplifier', () => {
    expect(isShallowDepth({})).toBe(false);
    expect(isShallowDepth({ meanDepthM: undefined, maxDepthM: undefined })).toBe(false);
  });

  it('uses the mean-depth threshold when a mean is present', () => {
    expect(isShallowDepth({ meanDepthM: SHALLOW_MEAN_DEPTH_M })).toBe(true);
    expect(isShallowDepth({ meanDepthM: SHALLOW_MEAN_DEPTH_M - 0.5 })).toBe(true);
    expect(isShallowDepth({ meanDepthM: SHALLOW_MEAN_DEPTH_M + 0.5 })).toBe(false);
  });

  it('falls back to max depth only when the mean is absent', () => {
    expect(isShallowDepth({ maxDepthM: SHALLOW_MAX_DEPTH_M })).toBe(true);
    expect(isShallowDepth({ maxDepthM: SHALLOW_MAX_DEPTH_M + 1 })).toBe(false);
    // A deep mean wins over a shallow max and vice versa: the mean describes the sheet.
    expect(isShallowDepth({ meanDepthM: 20, maxDepthM: 2 })).toBe(false);
    expect(isShallowDepth({ meanDepthM: 1, maxDepthM: 60 })).toBe(true);
  });

  it('ignores garbage values and falls through to the next signal', () => {
    expect(isShallowDepth({ meanDepthM: 0, maxDepthM: 2 })).toBe(true);
    expect(isShallowDepth({ meanDepthM: Number.NaN, maxDepthM: 2 })).toBe(true);
    expect(isShallowDepth({ meanDepthM: -5, maxDepthM: 40 })).toBe(false);
    expect(isShallowDepth({ meanDepthM: 0, maxDepthM: 0 })).toBe(false);
  });

  it('the max-depth fallback is looser than the mean threshold (the ~0.4 basin ratio)', () => {
    expect(SHALLOW_MAX_DEPTH_M).toBeGreaterThan(SHALLOW_MEAN_DEPTH_M);
  });

  it('concrete: Shelburne Pond is shallow at 194 ha, Willoughby is not at 703 ha', () => {
    // The pair that makes area a bad proxy for depth, which is why D68 exists.
    expect(isShallowDepth({ meanDepthM: 1.5 })).toBe(true);
    expect(isShallowDepth({ meanDepthM: 30, maxDepthM: 96 })).toBe(false);
  });

  it('property: monotone in mean depth — deeper is never more shallow', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (mean, extra) => {
          if (isShallowDepth({ meanDepthM: mean + extra })) {
            expect(isShallowDepth({ meanDepthM: mean })).toBe(true);
          }
        },
      ),
    );
  });
});

describe('describeLakeDepth (the D3 display framing)', () => {
  it('renders nothing when there is no depth — not "unknown"', () => {
    // Most of the corpus. A depth we don't have is not a fact about the lake.
    expect(describeLakeDepth({})).toBeNull();
    expect(describeLakeDepth({ meanDepthM: 4 })).toBeNull(); // no source ⇒ not displayable
    expect(describeLakeDepth({ meanDepthSource: 'lagos_us' })).toBeNull(); // no number
  });

  it('a measured depth reads plainly and names its source', () => {
    const d = describeLakeDepth({
      meanDepthM: 4,
      meanDepthSource: 'state_agency',
      maxDepthM: 18,
      maxDepthSource: 'state_agency',
    });
    expect(d?.text).toBe('mean 13 ft · max 59 ft');
    expect(d?.hasEstimate).toBe(false);
    expect(d?.caption).toBe('Depth: state survey.');
    expect(d?.caption).not.toContain('~');
  });

  it('a modeled depth is marked, and the mark is PER VALUE', () => {
    // The case that forced per-measurement provenance: LAGOS-US holds ~3× more maxima than means, so a
    // measured max beside a modeled mean is the normal shape, not an edge case.
    const d = describeLakeDepth({
      meanDepthM: 4,
      meanDepthSource: 'hydrolakes_modeled',
      maxDepthM: 18,
      maxDepthSource: 'lagos_us',
    });
    expect(d?.text).toBe('mean ~13 ft · max 59 ft');
    expect(d?.hasEstimate).toBe(true);
    expect(d?.caption).toContain('~ is a modeled estimate');
    expect(d?.caption).toContain('LAGOS-US DEPTH');
    expect(d?.caption).toContain('HydroLAKES (modeled)');
  });

  it('names sources in ladder order and dedupes them', () => {
    const d = describeLakeDepth({
      meanDepthM: 4,
      meanDepthSource: 'globathy',
      maxDepthM: 18,
      maxDepthSource: 'operator',
    });
    expect(d?.caption.indexOf('moderator')).toBeLessThan(d?.caption.indexOf('GLOBathy') as number);

    const same = describeLakeDepth({
      meanDepthM: 4,
      meanDepthSource: 'lagos_us',
      maxDepthM: 18,
      maxDepthSource: 'lagos_us',
    });
    expect(same?.caption).toBe('Depth: LAGOS-US DEPTH.');
  });

  it('shows a max alone without inventing a mean', () => {
    const d = describeLakeDepth({ maxDepthM: 18, maxDepthSource: 'globathy' });
    expect(d?.text).toBe('max ~59 ft');
  });

  it('drops a garbage value rather than rendering it', () => {
    expect(
      describeLakeDepth({
        meanDepthM: 0,
        meanDepthSource: 'lagos_us',
        maxDepthM: 18,
        maxDepthSource: 'lagos_us',
      })?.text,
    ).toBe('max 59 ft');
    expect(describeLakeDepth({ meanDepthM: Number.NaN, meanDepthSource: 'lagos_us' })).toBeNull();
  });

  it('property: a measured-only body never renders a tilde or an estimate caveat', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('operator' as const, 'state_agency' as const, 'lagos_us' as const),
        fc.double({ min: 0.5, max: 300, noNaN: true }),
        (source, depth) => {
          const d = describeLakeDepth({ maxDepthM: depth, maxDepthSource: source });
          expect(d?.text).not.toContain('~');
          expect(d?.hasEstimate).toBe(false);
        },
      ),
    );
  });

  it('property: any modeled value always yields a tilde and the caveat', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'hydrolakes_reported' as const,
          'hydrolakes_modeled' as const,
          'globathy' as const,
        ),
        fc.double({ min: 0.5, max: 300, noNaN: true }),
        (source, depth) => {
          const d = describeLakeDepth({ meanDepthM: depth, meanDepthSource: source });
          expect(d?.text).toContain('~');
          expect(d?.hasEstimate).toBe(true);
          expect(d?.caption).toContain('modeled estimate');
        },
      ),
    );
  });
});
