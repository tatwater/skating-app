import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fitCamera, stillSurface } from '@/lib/mapSurface';
import {
  formatLatitude,
  formatLongitude,
  graticuleLayout,
  graticuleStep,
  LABEL_HEIGHT,
  LABEL_WIDTH,
  type Rect,
  stepDecimals,
} from './graticule';

/** Mascoma Lake's bounds (the Body console boards' lake): real geography for the drawing. */
const MASCOMA_BOUNDS = {
  maxLat: 43.6497901,
  maxLng: -72.1206902,
  minLat: 43.6061979,
  minLng: -72.1819521,
};
/** The Body console's framing room (its rack, dock and key). */
const FIT_PADDING = { top: 30, right: 70, bottom: 90, left: 175 };

/** Board 5.4.1's map: 656 × 830, framed on Mascoma as the console frames it. */
const surface = stillSurface(656, 830, fitCamera(MASCOMA_BOUNDS, 656, 830, FIT_PADDING));

describe('the step', () => {
  it('is the finest round step whose parallels stand far enough apart', () => {
    expect(graticuleStep(10_000, 34)).toBe(0.005);
    expect(graticuleStep(10_000, 60)).toBe(0.01);
    expect(graticuleStep(1, 34)).toBe(10);
  });

  it('writes as many decimals as the step needs', () => {
    expect(stepDecimals(0.01)).toBe(2);
    expect(stepDecimals(0.0025)).toBe(4);
    expect(stepDecimals(0.5)).toBe(1);
    expect(stepDecimals(1)).toBe(0);
  });

  it('labels by hemisphere', () => {
    expect(formatLatitude(43.66, 2)).toBe('43.66°N');
    expect(formatLatitude(-0.5, 2)).toBe('0.50°S');
    expect(formatLongitude(-72.2, 2)).toBe('72.20°W');
    expect(formatLongitude(3, 0)).toBe('3°E');
  });
});

describe('graticuleLayout', () => {
  const layout = graticuleLayout({ ...surface, minSpacing: 60, footInset: 30 });

  it('draws Mascoma in hundredths of a degree, as the board does', () => {
    expect(layout.step).toBe(0.01);
    const lat = layout.labels.filter((l) => l.anchor === 'end').map((l) => l.text);
    const lng = layout.labels.filter((l) => l.anchor === 'start').map((l) => l.text);
    expect(lat).toContain('43.63°N');
    expect(lng).toContain('72.15°W');
    expect(lat.every((t) => /^\d+\.\d{2}°N$/.test(t))).toBe(true);
  });

  it('runs the longitude row over the foot', () => {
    for (const l of layout.labels.filter((x) => x.anchor === 'start')) {
      expect(l.y).toBe(830 - 30 - 7);
    }
  });

  it('draws nothing for a pane with no size', () => {
    expect(graticuleLayout({ ...surface, width: 0 }).labels).toEqual([]);
  });

  it('never sets a label on the chrome, nor past the pane (property)', () => {
    const rect = fc
      .record({
        x: fc.integer({ min: 0, max: 600 }),
        y: fc.integer({ min: 0, max: 800 }),
        w: fc.integer({ min: 10, max: 200 }),
        h: fc.integer({ min: 10, max: 200 }),
      })
      .map(({ x, y, w, h }): Rect => ({ left: x, top: y, right: x + w, bottom: y + h }));
    fc.assert(
      fc.property(
        fc.array(rect, { maxLength: 4 }),
        fc.double({ min: 10, max: 14, noNaN: true }),
        (keepouts, zoom) => {
          const s = stillSurface(656, 830, { center: { lng: -72.152, lat: 43.627 }, zoom });
          const out = graticuleLayout({ ...s, keepouts, footInset: 30 });
          for (const l of out.labels) {
            const left = l.anchor === 'start' ? l.x : l.x - LABEL_WIDTH;
            const box = {
              left,
              right: left + LABEL_WIDTH,
              top: l.y - LABEL_HEIGHT + 2,
              bottom: l.y + 2,
            };
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(656);
            for (const k of keepouts) {
              const hit =
                box.left < k.right &&
                box.right > k.left &&
                box.top < k.bottom &&
                box.bottom > k.top;
              expect(hit).toBe(false);
            }
          }
        },
      ),
    );
  });

  it('keeps a label where it was when the map pans a little (no hopping)', () => {
    const a = graticuleLayout({ ...surface, minSpacing: 60 });
    const panned = stillSurface(656, 830, {
      center: { lng: surface.center.lng - 0.0005, lat: surface.center.lat },
      zoom: surface.zoom,
    });
    const b = graticuleLayout({ ...panned, minSpacing: 60 });
    const lngA = a.labels.filter((l) => l.anchor === 'start').map((l) => l.text);
    const lngB = b.labels.filter((l) => l.anchor === 'start').map((l) => l.text);
    expect(lngB.filter((t) => lngA.includes(t)).length).toBeGreaterThanOrEqual(lngA.length - 1);
  });
});
