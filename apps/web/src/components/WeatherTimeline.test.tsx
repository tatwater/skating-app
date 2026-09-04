import type { TimelineDayInput } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `next-themes` reads `matchMedia` on mount; the chart only needs the resolved name.
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));

/**
 * A `ResizeObserver` that actually reports a width.
 *
 * ⚠ **The shared setup stubs a no-op one**, which is right for the Recharts admin pages (they assert
 * scaffolding, not geometry) and useless here: since the 2026-09-04 scale change the component
 * derives *how much there is to scroll* from `contentWidth − viewportWidth`, so a viewport of 0 makes
 * everything look scrollable and the "it all fits" case untestable. This reports a real box.
 */
let observedWidth = 376;
beforeEach(() => {
  observedWidth = 376;
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width: observedWidth } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const { WeatherTimeline } = await import('./WeatherTimeline');

const DAY_MS = 86_400_000;
const D0 = Date.UTC(2026, 0, 1);
/** 2 px/hour × 24 — one day's drawn width, and the keyboard's step. */
const DAY_PX = 48;

function day(i: number): TimelineDayInput {
  const date = new Date(D0 + i * DAY_MS).toISOString().slice(0, 10);
  return {
    dayMs: D0 + i * DAY_MS,
    localDate: date,
    hours: Array.from({ length: 24 }, (_, h) => ({
      localDate: date,
      localHour: h,
      temperatureC: -5,
      windSpeedKph: 4,
    })),
  };
}

const renderTimeline = (totalDays: number) =>
  render(<WeatherTimeline days={Array.from({ length: totalDays }, (_, i) => day(i))} />);

describe('WeatherTimeline scrubber', () => {
  it('renders nothing to scroll when the whole range fits the viewport', () => {
    // 7 days × 48 = 336 px, inside a 376 px plot.
    renderTimeline(7);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('appears as soon as the content is wider than the viewport', () => {
    // 8 days × 48 = 384 px, which does not fit 376 — and the eighth column is the cropped one that
    // signals scrollability in the first place.
    renderTimeline(8);
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });

  it('announces its position in days, not pixels', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveAttribute('aria-valuetext', 'Showing the most recent days');
  });

  it('is reachable by keyboard, which is the only non-mouse route to the older days', () => {
    // ⚠ The chart itself is `aria-hidden` — a screen reader gets the panel's sentences, not a
    // description of 720 line segments. Without arrow keys the earlier weather is pointer-only.
    renderTimeline(30);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider).toHaveAttribute('aria-valuetext', '1.0 days back');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Showing the most recent days');
  });

  it('steps a whole day per arrow even though the scroll itself is continuous', () => {
    // A keyboard step that landed mid-afternoon would be impossible to aim with.
    renderTimeline(30);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider).toHaveAttribute('aria-valuetext', '2.0 days back');
  });

  it('jumps a week with PageUp and to the ends with Home/End', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(slider).toHaveAttribute('aria-valuetext', '7.0 days back');

    fireEvent.keyDown(slider, { key: 'Home' });
    // 30 days of content (1440 px) in a 376 px viewport leaves 1064 px = 22.2 days of travel.
    expect(slider).toHaveAttribute('aria-valuetext', '22.2 days back');

    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Showing the most recent days');
  });

  it('clamps at both ends rather than running past them', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowRight' }); // already newest
    expect(slider).toHaveAttribute('aria-valuenow', '0');

    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' }); // already oldest
    expect(slider).toHaveAttribute('aria-valuetext', '22.2 days back');
  });

  it('ignores keys it does not own, so the panel keeps its own shortcuts', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    fireEvent.keyDown(slider, { key: 'a' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
  });

  it('scales the travel with the viewport, not with a day count', () => {
    // The same 30 days in a wider plot have less to scroll — which is the fixed scale working.
    observedWidth = 1000;
    renderTimeline(30);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'Home' });
    // 1440 − 1000 = 440 px = 9.2 days, against 22.2 at 376 px.
    expect(slider).toHaveAttribute('aria-valuetext', '9.2 days back');
  });
});

describe('WeatherTimeline drawing', () => {
  it('draws an hour at the same width whatever the container', () => {
    // The regression the scale change exists to prevent: one week, three shapes.
    const widths = [326, 376, 900];
    const dayWidths = widths.map((w) => {
      observedWidth = w;
      const { container, unmount } = render(
        <WeatherTimeline days={Array.from({ length: 10 }, (_, i) => day(i))} />,
      );
      // Day dividers land on multiples of the day width; the first two are one day apart.
      const lines = [...container.querySelectorAll('line')].map((l) =>
        Number(l.getAttribute('x1')),
      );
      const sorted = [...new Set(lines)].sort((a, b) => a - b);
      const spacing = sorted.filter((x) => x > 0).slice(0, 2);
      unmount();
      return (spacing[1] ?? 0) - (spacing[0] ?? 0);
    });
    for (const w of dayWidths) expect(w).toBeCloseTo(DAY_PX);
  });
});
