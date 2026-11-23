import { act, fireEvent, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coverCrop, mosaicGrid, PhotoStage, PhotoThumb } from './photo-stage';

/**
 * **What the stage fetches before it is shown**: only the thumbnail, by a detached image that is
 * never in the document — the full photo not at all. The page's attributes can't show a detached
 * fetch, so the image constructor is stood in and every address it is handed is recorded.
 */

const fetched: string[] = [];
/** Every detached image made, so a test can fail its load. */
const made: { onerror: (() => void) | null }[] = [];
const RealImage = globalThis.Image;

beforeEach(() => {
  fetched.length = 0;
  made.length = 0;
  globalThis.Image = class {
    decoding = '';
    referrerPolicy = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      made.push(this);
    }
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

const stage = (shown: boolean, full: string | null = FULL, fullFailed = false) => (
  <PhotoStage
    thumb={THUMB}
    full={full}
    fullFailed={fullFailed}
    loadingLabel="Loading the photo…"
    thumbUnavailable="The thumbnail couldn’t be loaded"
    fullUnavailable="The photo couldn’t be loaded"
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
      <PhotoThumb
        thumb={THUMB}
        shown={false}
        label="Photo 1, pixelated"
        alt="Photo 1"
        unavailable="The thumbnail couldn’t be loaded"
      />,
    );
    expect(fetched).toEqual([THUMB]);
    expect(container.querySelector('img')).toBeNull();
    rerender(
      <PhotoThumb
        thumb={null}
        shown
        label="Photo 1, pixelated"
        alt="Photo 1"
        unavailable="The thumbnail couldn’t be loaded"
      />,
    );
    expect(container.querySelector('img, canvas')).toBeNull();
  });
});

describe('when an image won’t load (R15-6)', () => {
  it('a thumbnail that fails says so, never a blank field', () => {
    const { container } = render(stage(false));
    act(() => made.at(-1)?.onerror?.());
    expect(container.querySelector('canvas')).toBeNull();
    expect(container).toHaveTextContent('The thumbnail couldn’t be loaded');
  });

  it('shown while the full photo is on its way: still pixelated, never the thumbnail unpixelated', () => {
    const { container } = render(stage(true, null));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(container).toHaveTextContent('Loading the photo…');
  });

  it('a failed fetch, or a full image that won’t load: words, never the broken glyph or the thumbnail', () => {
    const failed = render(stage(true, null, true));
    expect(failed.container.querySelector('img, canvas')).toBeNull();
    expect(failed.container).toHaveTextContent('The photo couldn’t be loaded');
    failed.unmount();
    const broken = render(stage(true));
    const img = broken.container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(FULL);
    fireEvent.error(img);
    expect(broken.container.querySelector('img, canvas')).toBeNull();
    expect(broken.container).toHaveTextContent('The photo couldn’t be loaded');
    expect(broken.container.innerHTML).not.toContain(THUMB);
  });

  it('shown, the caption is announced once: by the image, not the figure too', () => {
    const { container } = render(stage(true));
    expect(container.querySelector('figure')).not.toHaveAttribute('aria-label');
    expect(container.querySelector('img')).toHaveAttribute('alt', 'The flagged photo');
    const pixelated = render(stage(false));
    expect(pixelated.container.querySelector('figure')).toHaveAttribute(
      'aria-label',
      'The flagged photo, pixelated',
    );
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
