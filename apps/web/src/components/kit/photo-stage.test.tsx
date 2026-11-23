import { render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coverCrop, mosaicGrid, PhotoStage, PhotoThumb } from './photo-stage';

/**
 * **What the stage fetches before it is shown**: only the thumbnail, by a detached image that is
 * never in the document — the full photo not at all. The page's attributes can't show a detached
 * fetch, so the image constructor is stood in and every address it is handed is recorded.
 */

const fetched: string[] = [];
const RealImage = globalThis.Image;

beforeEach(() => {
  fetched.length = 0;
  globalThis.Image = class {
    decoding = '';
    referrerPolicy = '';
    onload: (() => void) | null = null;
    set src(v: string) {
      fetched.push(v);
    }
    removeAttribute() {}
  } as unknown as typeof Image;
});
afterEach(() => {
  globalThis.Image = RealImage;
});

const THUMB = 'https://files.example/thumb';
const FULL = 'https://files.example/full';

const stage = (shown: boolean) => (
  <PhotoStage
    thumb={THUMB}
    full={FULL}
    shown={shown}
    onShow={() => {}}
    onPixelate={() => {}}
    alt="The flagged photo"
    label="The flagged photo, pixelated"
    veil="Pixelated until you choose to look"
    showLabel="Show the photo"
    pixelateLabel="Pixelate again"
  />
);

describe('the pixelated stage', () => {
  it('fetches only the thumbnail, never the full photo, until shown', () => {
    const { container } = render(stage(false));
    expect(fetched).toEqual([THUMB]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain(FULL);
    // The bitmap is the mosaic: 24 cells across.
    expect(container.querySelector('canvas')?.width).toBe(24);
  });

  it('once shown, puts the full photo in the page as an image, and fetches no mosaic', () => {
    const { container } = render(stage(true));
    expect(fetched).toEqual([]);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(FULL);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('a thumbnail fetches its own address only, and draws no image until shown', () => {
    const { container, rerender } = render(
      <PhotoThumb thumb={THUMB} shown={false} label="Photo 1, pixelated" alt="Photo 1" />,
    );
    expect(fetched).toEqual([THUMB]);
    expect(container.querySelector('img')).toBeNull();
    rerender(<PhotoThumb thumb={null} shown label="Photo 1, pixelated" alt="Photo 1" />);
    expect(container.querySelector('img, canvas')).toBeNull();
  });
});

describe('the mosaic’s grid', () => {
  it('is never finer than its cells across, and never empty (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.double({ min: 0, max: 4000, noNaN: true }),
        fc.double({ min: 0, max: 4000, noNaN: true }),
        (cells, w, h) => {
          const g = mosaicGrid(cells, w, h);
          expect(g.cols).toBe(cells);
          expect(g.rows).toBeGreaterThanOrEqual(1);
        },
      ),
    );
  });

  it('crops as cover does: the box’s shape, centered, inside the image (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 64 }),
        (iw, ih, cols, rows) => {
          const c = coverCrop(iw, ih, cols, rows);
          expect(c.sx).toBeGreaterThanOrEqual(-1e-9);
          expect(c.sy).toBeGreaterThanOrEqual(-1e-9);
          expect(c.sx + c.sw).toBeLessThanOrEqual(iw + 1e-6);
          expect(c.sy + c.sh).toBeLessThanOrEqual(ih + 1e-6);
          expect(c.sw / c.sh).toBeCloseTo(cols / rows, 6);
        },
      ),
    );
  });
});
