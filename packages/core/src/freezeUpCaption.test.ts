import { describe, expect, it } from 'vitest';
import {
  frameDateLabel,
  frameSourceHint,
  frameSourceLabel,
  gapDaysBetween,
  stopCaption,
  stopCaveat,
} from './freezeUpCaption';
import type { IndexedFrame } from './imageryArchive';
import type { TimelineStop } from './imageryTimeline';

const frame = (over: Partial<IndexedFrame> = {}): IndexedFrame => ({
  granuleId: 'S2C_18TXP_20251222_0_L2A',
  capturedAt: '2025-12-22T15:51:05Z',
  cloudCoverPct: 7.6,
  bodies: 9,
  band: 'visual',
  key: 'frames/winter-2025-26/S2C_18TXP_20251222_0_L2A-visual.pmtiles',
  ...over,
});

const stop = (over: Partial<TimelineStop> = {}): TimelineStop => ({
  frame: frame(),
  landable: true,
  basis: 'measured',
  ...over,
});

describe('frameDateLabel', () => {
  it('reads unambiguously, without guessing day/month order', () => {
    expect(frameDateLabel('2025-12-22T15:51:05Z')).toBe('Dec 22, 2025');
  });

  it('⚠ formats in UTC, so a late-afternoon pass does not slide to the previous day', () => {
    // Sentinel-2 crosses mid-morning local, but radar passes are often after 22:00 UTC. Formatting in
    // the viewer's zone would date those a day earlier west of Greenwich, and the date is the content.
    expect(frameDateLabel('2025-11-02T22:51:23Z')).toBe('Nov 2, 2025');
  });

  it('says so rather than rendering Invalid Date', () => {
    expect(frameDateLabel('not a date')).toBe('unknown date');
  });
});

describe('frameSourceLabel', () => {
  it('names each published band', () => {
    expect(frameSourceLabel('visual')).toBe('Sentinel-2 true color');
    expect(frameSourceLabel('vh')).toBe('Sentinel-1 radar (VH)');
    expect(frameSourceLabel('scl')).toBe('Sentinel-2 scene classification');
  });

  it('falls back to the raw band rather than inventing a name', () => {
    expect(frameSourceLabel('ndsi')).toBe('ndsi');
  });
});

describe('stopCaveat — three shapes, and the difference is the point', () => {
  it('says "of the lake" only when a manifest measured this lake', () => {
    expect(
      stopCaveat(
        stop({ stats: { waterBodyId: 'x', coveragePct: 1, clearPct: 0.62, pixels: 4107 } }),
      ),
    ).toBe('38% of the lake under cloud');
  });

  it('⚠ says "over the region" when only the granule figure exists', () => {
    // `eo:cloud_cover` describes a 110 km tile, so two lakes in one granule always report the same
    // number. "94% cloud over Lake George" would be a claim about a lake we did not measure.
    expect(stopCaveat(stop({ basis: 'inferred', frame: frame({ cloudCoverPct: 94 }) }))).toBe(
      '94% cloud over the region',
    );
  });

  it('captions a clipped pass as coverage, not as cloud', () => {
    expect(
      stopCaveat(
        stop({
          blockedBy: 'coverage',
          landable: false,
          stats: { waterBodyId: 'x', coveragePct: 0.15, clearPct: 0.99, pixels: 400 },
        }),
      ),
    ).toBe('only 15% of the lake in this pass');
  });

  it('says nothing when there was nothing in the way', () => {
    expect(
      stopCaveat(stop({ stats: { waterBodyId: 'x', coveragePct: 1, clearPct: 1, pixels: 4107 } })),
    ).toBeNull();
  });

  it('⚠ never puts a cloud caveat on radar', () => {
    // A `vh` frame carries a null cloud figure because the question does not apply — Sentinel-1 sees
    // through cloud. Inventing a caveat would warn about the one thing this sensor is immune to.
    expect(
      stopCaveat(
        stop({
          frame: frame({ band: 'vh', cloudCoverPct: null }),
          stats: { waterBodyId: 'x', coveragePct: 0.98, vhDb: -21.4, pixels: 4107 },
        }),
      ),
    ).toBeNull();
  });

  it('does not invent a caveat from an unreported optical figure either', () => {
    expect(
      stopCaveat(stop({ basis: 'inferred', frame: frame({ cloudCoverPct: null }) })),
    ).toBeNull();
  });
});

describe('stopCaption', () => {
  it('assembles date, source and caveat as separate parts', () => {
    expect(
      stopCaption(
        stop({ stats: { waterBodyId: 'x', coveragePct: 1, clearPct: 0.5, pixels: 4107 } }),
      ),
    ).toEqual({
      date: 'Dec 22, 2025',
      source: 'Sentinel-2 true color',
      caveat: '50% of the lake under cloud',
    });
  });

  it('⚠ never says anything about ice, in any branch', () => {
    // D150's gap is short and tempting — "82% water" to "not frozen" to "not skateable" — and the
    // last two are claims nothing in this pipeline can support. Phrasing a classification is N6g's.
    const captions = [
      stopCaption(stop()),
      stopCaption(stop({ frame: frame({ band: 'vh', cloudCoverPct: null }) })),
      stopCaption(
        stop({
          blockedBy: 'coverage',
          landable: false,
          stats: { waterBodyId: 'x', coveragePct: 0.1, pixels: 40 },
        }),
      ),
    ];
    for (const caption of captions) {
      const all = `${caption.date} ${caption.source} ${caption.caveat ?? ''}`.toLowerCase();
      expect(all).not.toMatch(/\b(ice|frozen|freeze|skat|safe|thaw)/);
    }
  });
});

describe('gapDaysBetween — a date from space is a bracket', () => {
  it('counts the days a freeze-up could be hiding in', () => {
    expect(gapDaysBetween('2025-11-22T15:00:00Z', '2025-12-22T15:00:00Z')).toBe(30);
  });

  it('returns a number rather than a word, so the caller cannot round it to "recently"', () => {
    expect(gapDaysBetween('2026-01-11T15:00:00Z', '2026-01-16T15:00:00Z')).toBe(5);
  });

  it('never goes negative on out-of-order input', () => {
    expect(gapDaysBetween('2026-01-16T15:00:00Z', '2026-01-11T15:00:00Z')).toBe(0);
  });

  it('returns null on an unparseable date', () => {
    expect(gapDaysBetween('nope', '2026-01-16T15:00:00Z')).toBeNull();
  });
});

describe('frameSourceHint — how to read the band', () => {
  it('⚠ leads with what radar CANNOT tell you, because that is the part that gets someone hurt', () => {
    // Radar's failure mode is our exact use case: smooth new black ice is specular and returns dark,
    // and so does calm open water. A hint that sold "sees through cloud!" and buried that would be
    // worse than none.
    const hint = frameSourceHint('vh') ?? '';
    expect(hint).toMatch(/open water/);
    expect(hint).toMatch(/smooth ice/);
  });

  it('names optical’s mirror-image ambiguity', () => {
    // Snow, ice and cloud are all simply white — which is the entire reason NDSI exists.
    expect(frameSourceHint('visual')).toMatch(/snow, ice or cloud/);
  });

  it('says nothing at all about a band it has nothing short and true to say about', () => {
    // Renders as no line, never as filler.
    expect(frameSourceHint('vv')).toBeNull();
    expect(frameSourceHint('')).toBeNull();
  });
});
