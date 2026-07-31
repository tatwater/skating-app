import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEPTH_SOURCE_LABELS,
  DEPTH_SOURCE_RANK,
  DEPTH_SOURCES,
  describeLakeDepth,
  isMeasuredDepthSource,
  isShallowDepth,
  SHALLOW_MAX_DEPTH_M,
  SHALLOW_MEAN_DEPTH_M,
} from './lakeDepth';

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

describe('describeLakeDepth — the operator source note (D68 amendment)', () => {
  it('shows the note in place of the generic operator label', () => {
    const d = describeLakeDepth({
      maxDepthM: 18,
      maxDepthSource: 'operator',
      depthSourceNote: 'NH Fish & Game bathymetry, 1998',
    });
    expect(d?.caption).toBe('Depth: NH Fish & Game bathymetry, 1998.');
    expect(d?.caption).not.toContain('moderator');
  });

  it('falls back to the generic label when there is no note — honest, not blank', () => {
    const d = describeLakeDepth({ maxDepthM: 18, maxDepthSource: 'operator' });
    expect(d?.caption).toBe('Depth: entered by a moderator.');
  });

  it('ignores a whitespace-only note', () => {
    const d = describeLakeDepth({
      maxDepthM: 18,
      maxDepthSource: 'operator',
      depthSourceNote: '   ',
    });
    expect(d?.caption).toBe('Depth: entered by a moderator.');
  });

  it('does NOT attach the note to a non-operator source', () => {
    // A stray note next to a modelled value must not read as a citation for the model's number.
    const d = describeLakeDepth({
      maxDepthM: 18,
      maxDepthSource: 'globathy',
      depthSourceNote: 'NH Fish & Game, 1998',
    });
    expect(d?.caption).toContain('GLOBathy (modeled)');
    expect(d?.caption).not.toContain('Fish & Game');
  });

  it('substitutes only the operator rung when sources are mixed', () => {
    const d = describeLakeDepth({
      meanDepthM: 4,
      meanDepthSource: 'operator',
      maxDepthM: 18,
      maxDepthSource: 'globathy',
      depthSourceNote: 'VT DEC chart, 2012',
    });
    expect(d?.caption).toContain('VT DEC chart, 2012');
    expect(d?.caption).toContain('GLOBathy (modeled)');
    expect(d?.caption).not.toContain('moderator');
  });
});
