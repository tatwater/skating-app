import { describe, expect, it } from 'vitest';
import { normalizeRose, WIND_ROSE_SECTORS } from './windRose';
import {
  areaPath,
  arrowPoints,
  polarPoint,
  ringFrequencies,
  WIND_ARROW_REFERENCE_MPS,
  WIND_ROSE_LABEL_BAND,
  windExposureSummary,
  windRoseChartModel,
} from './windRoseChart';

/** Willoughby as derived 2026-08-15 — bimodal NW/SSE, and its hardest wind from the rare east. */
const WILLOUGHBY_ROSE = [
  4, 2.1, 1.3, 1.1, 1.6, 2.8, 14.5, 15.3, 2.4, 1.9, 2.3, 3.1, 5.2, 11.4, 19.2, 11.7,
].map((p) => p / 100);
const WILLOUGHBY_MEAN_MPS = [
  2.25, 1.94, 2.24, 3.12, 6.26, 5.67, 5.57, 6.12, 3.23, 3.01, 3.65, 3.95, 3.74, 4.12, 4.2, 3.52,
];

const SIZE = 200;
const model = () =>
  windRoseChartModel({ rose: WILLOUGHBY_ROSE, meanWindMps: WILLOUGHBY_MEAN_MPS, size: SIZE });

describe('polarPoint', () => {
  it('puts north up and east right, matching the compass rather than the maths convention', () => {
    // SVG's y axis points down. Getting this backwards mirrors the rose about the horizontal — an
    // error that is invisible on a symmetric pond and wrong on every real lake.
    const c = { x: 100, y: 100 };
    const north = polarPoint(c, 50, 0);
    const east = polarPoint(c, 50, 90);
    const south = polarPoint(c, 50, 180);
    const west = polarPoint(c, 50, 270);
    expect(north.y).toBeCloseTo(50, 6);
    expect(north.x).toBeCloseTo(100, 6);
    expect(east.x).toBeCloseTo(150, 6);
    expect(east.y).toBeCloseTo(100, 6);
    expect(south.y).toBeCloseTo(150, 6);
    expect(west.x).toBeCloseTo(50, 6);
  });

  it('keeps every point on the circle it was asked for', () => {
    const c = { x: 0, y: 0 };
    for (let bearing = 0; bearing < 360; bearing += 7) {
      const p = polarPoint(c, 30, bearing);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(30, 9);
    }
  });
});

describe('windRoseChartModel', () => {
  it('draws nothing at all without a rose', () => {
    // An absent rose must render NOTHING. A model of zeros would draw a collapsed circle, which
    // reads as a measured calm rather than as "we never measured here" (D90's whole argument).
    expect(windRoseChartModel({ rose: [], size: SIZE })).toBeNull();
    expect(windRoseChartModel({ rose: [1, 2, 3], size: SIZE })).toBeNull();
    expect(
      windRoseChartModel({ rose: Array.from({ length: 16 }, () => 0), size: SIZE }),
    ).toBeNull();
  });

  it('refuses a zero or negative viewport rather than emitting NaN coordinates', () => {
    expect(windRoseChartModel({ rose: WILLOUGHBY_ROSE, size: 0 })).toBeNull();
    expect(windRoseChartModel({ rose: WILLOUGHBY_ROSE, size: -10 })).toBeNull();
  });

  it('gives one area vertex per sector, none outside the plot circle', () => {
    const m = model() as NonNullable<ReturnType<typeof windRoseChartModel>>;
    expect(m.areaPoints).toHaveLength(WIND_ROSE_SECTORS);
    for (const p of m.areaPoints) {
      const r = Math.hypot(p.x - m.center.x, p.y - m.center.y);
      expect(r).toBeLessThanOrEqual(m.plotRadius + 1e-9);
    }
  });

  it('puts the longest lobe on the commonest direction', () => {
    const m = model() as NonNullable<ReturnType<typeof windRoseChartModel>>;
    const radii = m.areaPoints.map((p) => Math.hypot(p.x - m.center.x, p.y - m.center.y));
    // NW (index 14) is Willoughby's commonest at 19.2%.
    expect(radii.indexOf(Math.max(...radii))).toBe(14);
    expect(Math.max(...radii)).toBeCloseTo(m.plotRadius, 6);
  });

  it('sizes arrows on an ABSOLUTE scale, so two lakes can be compared by eye', () => {
    const m = model() as NonNullable<ReturnType<typeof windRoseChartModel>>;
    const east = m.arrows.find((a) => a.sector === 4);
    expect(east?.meanMps).toBe(6.26);
    expect(east?.intensity).toBeCloseTo(6.26 / WIND_ARROW_REFERENCE_MPS, 9);

    // A calmer lake must draw visibly smaller arrows for the same sector — the property a per-lake
    // normalisation would destroy by making every chart peak at full size.
    const calm = windRoseChartModel({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: WILLOUGHBY_MEAN_MPS.map((v) => v / 3),
      size: SIZE,
    });
    const calmEast = calm?.arrows.find((a) => a.sector === 4);
    expect(calmEast?.intensity).toBeLessThan(east?.intensity as number);
  });

  it('shows the strongest arrow where the rose is nearly empty — the reason both are drawn', () => {
    // Willoughby's hardest average wind is from the EAST (6.26 m/s), which is also the direction
    // the ridges block: only 1.6% of winter hours. Frequency and force are different shores, and a
    // rose alone cannot say so. If this ever flips, the chart has stopped earning its second channel.
    const m = model() as NonNullable<ReturnType<typeof windRoseChartModel>>;
    const strongest = [...m.arrows].sort((a, b) => b.meanMps - a.meanMps)[0];
    expect(strongest?.sector).toBe(4);
    expect(strongest?.label).toBe('E');
    expect(WILLOUGHBY_ROSE[4]).toBeLessThan(0.02);
  });

  it('omits a sector with no reading instead of drawing a zero-length arrow', () => {
    const holes = [...WILLOUGHBY_MEAN_MPS] as (number | null)[];
    holes[4] = null;
    const m = windRoseChartModel({ rose: WILLOUGHBY_ROSE, meanWindMps: holes, size: SIZE });
    expect(m?.arrows.some((a) => a.sector === 4)).toBe(false);
    expect(m?.arrows).toHaveLength(WIND_ROSE_SECTORS - 1);
  });

  it('draws no arrows at all when mean speed is absent', () => {
    const m = windRoseChartModel({ rose: WILLOUGHBY_ROSE, size: SIZE });
    expect(m?.arrows).toHaveLength(0);
    // …but the rose itself still renders, because frequency stands on its own.
    expect(m?.areaPoints).toHaveLength(WIND_ROSE_SECTORS);
  });

  it('clamps a speed past the reference rather than overflowing the ring', () => {
    const gale = WILLOUGHBY_MEAN_MPS.map(() => WIND_ARROW_REFERENCE_MPS * 4);
    const m = windRoseChartModel({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: gale,
      size: SIZE,
    }) as NonNullable<ReturnType<typeof windRoseChartModel>>;
    for (const a of m.arrows) {
      expect(a.intensity).toBe(1);
      // Still inside the viewport: a clamp that overflowed would clip against the SVG edge.
      for (const p of a.points) {
        expect(Math.hypot(p.x - m.center.x, p.y - m.center.y)).toBeLessThanOrEqual(SIZE / 2 + 1e-6);
      }
    }
  });

  it('emphasises only the sector it was given, and never more than one', () => {
    const m = windRoseChartModel({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: WILLOUGHBY_MEAN_MPS,
      emphasizedSector: 7,
      size: SIZE,
    });
    expect(m?.arrows.filter((a) => a.emphasized)).toHaveLength(1);
    expect(m?.arrows.find((a) => a.emphasized)?.sector).toBe(7);
    expect(m?.emphasizedSector).toBe(7);
  });

  it('emphasises nothing when no sector was named', () => {
    // The chart must not invent its own "most exposed": one function owns that meaning (D90) so the
    // picture and the sentence beside it cannot disagree.
    const m = model();
    expect(m?.arrows.some((a) => a.emphasized)).toBe(false);
    expect(m?.emphasizedSector).toBeNull();
  });

  it('places the cardinals at the compass points, not the sector midpoints', () => {
    const m = model() as NonNullable<ReturnType<typeof windRoseChartModel>>;
    const north = m.cardinals.find((c) => c.label === 'N');
    const south = m.cardinals.find((c) => c.label === 'S');
    expect(north?.at.x).toBeCloseTo(SIZE / 2, 6);
    expect(north?.at.y).toBeLessThan(SIZE / 2);
    expect(south?.at.y).toBeGreaterThan(SIZE / 2);
  });
});

describe('ringFrequencies', () => {
  it('lands on percentages a reader can say out loud', () => {
    expect(ringFrequencies(0.192)).toEqual([0.05, 0.1, 0.15]);
  });

  it('never puts a ring at or beyond the maximum, so the area clears the outer gridline', () => {
    for (const max of [0.06, 0.12, 0.3, 0.55]) {
      for (const r of ringFrequencies(max)) expect(r).toBeLessThan(max);
    }
  });

  it('returns nothing for a rose too flat to have a ring below its max', () => {
    expect(ringFrequencies(0.04)).toEqual([]);
  });
});

describe('svg serialisation', () => {
  it('closes the area path', () => {
    const m = model() as NonNullable<ReturnType<typeof windRoseChartModel>>;
    const d = areaPath(m);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.trim().endsWith('Z')).toBe(true);
    expect(d.match(/L /g)).toHaveLength(WIND_ROSE_SECTORS - 1);
    expect(d).not.toContain('NaN');
  });

  it('emits three points per arrow and never NaN', () => {
    const m = model() as NonNullable<ReturnType<typeof windRoseChartModel>>;
    for (const a of m.arrows) {
      const pts = arrowPoints(a);
      expect(pts.split(' ')).toHaveLength(3);
      expect(pts).not.toContain('NaN');
    }
  });

  it('is empty for an empty model rather than throwing', () => {
    expect(areaPath({ areaPoints: [] } as never)).toBe('');
  });
});

describe('the rose it draws is the rose that was stored', () => {
  it('agrees with normalizeRose on a raw count vector', () => {
    const counts = [110, 58, 23, 20, 20, 102, 563, 468, 87, 58, 93, 107, 163, 264, 540, 229];
    const rose = normalizeRose(counts) as number[];
    const m = windRoseChartModel({ rose, size: SIZE }) as NonNullable<
      ReturnType<typeof windRoseChartModel>
    >;
    const radii = m.areaPoints.map((p) => Math.hypot(p.x - m.center.x, p.y - m.center.y));
    expect(radii.indexOf(Math.max(...radii))).toBe(rose.indexOf(Math.max(...rose)));
  });
});

describe('windExposureSummary', () => {
  const spoken = (p: string) => `the ${p.toLowerCase()}`;
  const miles = (m: number) => (m / 1609.344).toFixed(1);
  const base = {
    spokenDirection: spoken as never,
    formatMiles: miles,
    minFetchClauseM: 1000,
  };

  it('names the commonest direction with its share', () => {
    const s = windExposureSummary({ rose: WILLOUGHBY_ROSE, ...base });
    expect(s?.commonest.label).toBe('NW');
    expect(s?.sentences[0]).toContain('19%');
    expect(s?.sentences[0]).toContain('the nw');
  });

  it('says the hardest wind comes from a RARE direction when it does', () => {
    // The Willoughby case: strongest average is the east, which is also the blocked quadrant. A big
    // arrow on an almost-empty lobe looks like a bug unless the prose explains it.
    const s = windExposureSummary({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: WILLOUGHBY_MEAN_MPS,
      ...base,
    });
    expect(s?.strongest?.label).toBe('E');
    expect(s?.strongestDiffersFromCommonest).toBe(true);
    expect(s?.sentences[1]).toContain('rarely takes');
    expect(s?.sentences[1]).toContain('14 mph'); // 6.26 m/s
  });

  it('does not then repeat itself about the same quadrant', () => {
    const s = windExposureSummary({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: WILLOUGHBY_MEAN_MPS,
      ...base,
    });
    const rarely = s?.sentences.filter((t) => t.includes('rarely') || t.includes('almost never'));
    expect(rarely?.length).toBeLessThanOrEqual(1);
  });

  it('merges the two claims when force and frequency agree', () => {
    const mean = WILLOUGHBY_MEAN_MPS.map((_, i) => (i === 14 ? 9 : 2));
    const s = windExposureSummary({ rose: WILLOUGHBY_ROSE, meanWindMps: mean, ...base });
    expect(s?.strongestDiffersFromCommonest).toBe(false);
    expect(s?.sentences[1]).toContain('That is also where');
  });

  it('offers no cause for a blocked direction — only the absence', () => {
    // The mockup said "sheltered E and W by terrain". The terrain half is an inference this data
    // cannot support, and asserting it corpus-wide is D90's error running the other way.
    const s = windExposureSummary({ rose: WILLOUGHBY_ROSE, ...base });
    const all = (s?.sentences ?? []).join(' ');
    expect(all).not.toMatch(/terrain|mountain|ridge|sheltered|blocked by/i);
  });

  it('never warns — wind data is context, not counsel (D145)', () => {
    const s = windExposureSummary({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: WILLOUGHBY_MEAN_MPS,
      ...base,
    });
    const all = (s?.sentences ?? []).join(' ');
    expect(all).not.toMatch(/danger|hazard|unsafe|caution|risk|warning|beware/i);
  });

  it('makes no fetch claim below the caption s bar', () => {
    const shortFetch = Array.from({ length: 16 }, () => 400);
    const s = windExposureSummary({
      rose: WILLOUGHBY_ROSE,
      fetchProfileM: shortFetch,
      mostExposedSector: 14,
      ...base,
    });
    expect(s?.mostExposed).toBeNull();
    expect((s?.sentences ?? []).join(' ')).not.toContain('open water');
  });

  it('makes the fetch claim above it, on the sector it was handed', () => {
    const fetchProfileM = Array.from({ length: 16 }, (_, i) => (i === 7 ? 4500 : 300));
    const s = windExposureSummary({
      rose: WILLOUGHBY_ROSE,
      fetchProfileM,
      mostExposedSector: 7,
      ...base,
    });
    expect(s?.mostExposed?.label).toBe('SSE');
    expect((s?.sentences ?? []).join(' ')).toContain('open water');
  });

  it('degrades to one sentence with only a rose', () => {
    const s = windExposureSummary({ rose: WILLOUGHBY_ROSE.map(() => 1 / 16), ...base });
    expect(s?.strongest).toBeNull();
    expect(s?.mostExposed).toBeNull();
    expect(s?.blocked).toBeNull(); // a flat rose has no blocked direction to name
    expect(s?.sentences).toHaveLength(1);
  });

  it('returns null without a usable rose', () => {
    expect(windExposureSummary({ rose: [], ...base })).toBeNull();
    expect(windExposureSummary({ rose: Array.from({ length: 16 }, () => 0), ...base })).toBeNull();
  });
});

describe('the band layout (arrows were once 3px)', () => {
  it('keeps arrows out of the compass-label ring', () => {
    // The first version gave the arrows whatever was left after one `rimFraction` and then drew the
    // cardinals into the same space. Arrows collided with the letters AND were about 12px long.
    const m = windRoseChartModel({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: WILLOUGHBY_MEAN_MPS.map(() => WIND_ARROW_REFERENCE_MPS),
      size: SIZE,
    }) as NonNullable<ReturnType<typeof windRoseChartModel>>;
    const outer = SIZE / 2;
    const labelRingInner = outer - outer * WIND_ROSE_LABEL_BAND;
    for (const a of m.arrows) {
      for (const p of a.points) {
        expect(Math.hypot(p.x - m.center.x, p.y - m.center.y)).toBeLessThanOrEqual(
          labelRingInner + 1e-6,
        );
      }
    }
  });

  it('gives a MEDIAN lake a legible arrow, not a speck', () => {
    // The bug this pins. Corpus median peak is 4.7 m/s; against the old 15 m/s reference and the old
    // ~12px band that drew a 3px triangle. The fix was both halves — a reference set from the
    // distribution rather than the outlier, and a band that is actually reserved.
    const median = 4.7;
    const m = windRoseChartModel({
      rose: WILLOUGHBY_ROSE,
      meanWindMps: WILLOUGHBY_MEAN_MPS.map(() => median),
      size: SIZE,
    }) as NonNullable<ReturnType<typeof windRoseChartModel>>;
    const arrow = m.arrows[0] as NonNullable<(typeof m.arrows)[0]>;
    const tip = Math.hypot(arrow.points[0].x - m.center.x, arrow.points[0].y - m.center.y);
    const back = Math.hypot(arrow.points[1].x - m.center.x, arrow.points[1].y - m.center.y);
    const length = back - tip;
    // A tenth of the radius is the floor of "legible" at this chart size.
    expect(length).toBeGreaterThan((SIZE / 2) * 0.1);
  });

  it('scales the reference to the distribution, not to the single windiest cell', () => {
    // 10 m/s puts the median near half the band and clamps ~1.3% of lakes. Raising this back to the
    // observed 14.54 maximum makes the common case unreadable again.
    expect(WIND_ARROW_REFERENCE_MPS).toBe(10);
    expect(4.7 / WIND_ARROW_REFERENCE_MPS).toBeGreaterThan(0.4);
  });
});
