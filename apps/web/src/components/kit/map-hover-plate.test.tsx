import { render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapHoverPlate, plateFlip } from './map-controls';

/**
 * The hover plate stays inside its pane: it flips to its point's left past the right edge (when the
 * left has more room) and below it past the top — and where it fits, it never moves.
 */

const coord = fc.double({ min: 0, max: 800, noNaN: true });
const size = fc.double({ min: 1, max: 300, noNaN: true });

describe('plateFlip', () => {
  it('never moves a plate that fits up and right of its point', () => {
    fc.assert(
      fc.property(coord, coord, size, size, (x, y, w, h) => {
        const pane = { width: x + 12 + w + 1, height: 900 };
        expect(plateFlip({ x, y: y + h + 12 }, { width: w, height: h }, pane, 12)).toEqual({
          x: false,
          y: false,
        });
      }),
    );
  });

  it('flips left past the right edge only when the left has more room', () => {
    expect(
      plateFlip({ x: 280, y: 200 }, { width: 160, height: 40 }, { width: 300, height: 300 }, 12),
    ).toEqual({ x: true, y: false });
    // Too wide either way, but more room on the right: it stays.
    expect(
      plateFlip({ x: 40, y: 200 }, { width: 400, height: 40 }, { width: 300, height: 300 }, 12).x,
    ).toBe(false);
  });

  it('flips below past the top', () => {
    expect(
      plateFlip({ x: 20, y: 30 }, { width: 100, height: 40 }, { width: 300, height: 300 }, 12),
    ).toEqual({ x: false, y: true });
  });

  it('flips nothing in a pane with no size (not laid out yet)', () => {
    expect(
      plateFlip({ x: 280, y: 0 }, { width: 160, height: 40 }, { width: 0, height: 0 }, 12),
    ).toEqual({ x: false, y: false });
  });
});

describe('MapHoverPlate', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Lays the plate out at `w × h` in a `pw × ph` pane. */
  function layout(w: number, h: number, pw: number, ph: number) {
    const pane = { clientWidth: pw, clientHeight: ph } as HTMLElement;
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(pane);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(w);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(h);
  }
  const plate = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="map-hover-plate"]');

  it('sits up and right of its point where it fits', () => {
    layout(120, 40, 600, 400);
    const { container } = render(
      <MapHoverPlate at={{ x: 100, y: 200 }}>Relham Island</MapHoverPlate>,
    );
    const el = plate(container);
    expect(el?.style.left).toBe('112px');
    expect(el?.style.top).toBe('188px');
    expect(el?.className).toContain('-translate-y-full');
    expect(el).not.toHaveAttribute('data-flip-x');
  });

  it('flips to the left near the right edge and below near the top', () => {
    layout(160, 40, 300, 300);
    const { container } = render(
      <MapHoverPlate at={{ x: 280, y: 20 }}>Fairlee town launch</MapHoverPlate>,
    );
    const el = plate(container);
    expect(el).toHaveAttribute('data-flip-x');
    expect(el).toHaveAttribute('data-flip-y');
    expect(el?.style.left).toBe('268px');
    expect(el?.className).toContain('-translate-x-full');
    expect(el?.style.top).toBe('32px');
    expect(el?.className).not.toContain('-translate-y-full');
  });

  it('draws nothing with no point', () => {
    expect(render(<MapHoverPlate at={null}>x</MapHoverPlate>).container).toBeEmptyDOMElement();
  });
});
