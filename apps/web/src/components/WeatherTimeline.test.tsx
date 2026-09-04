import type { TimelineDayInput } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// `next-themes` reads `matchMedia` on mount, which jsdom does not implement; the shared test setup
// stubs it, and the chart only needs the resolved name.
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));

const { WeatherTimeline } = await import('./WeatherTimeline');

const DAY_MS = 86_400_000;
const D0 = Date.UTC(2026, 0, 1);

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

/**
 * jsdom reports every element as 0×0, so the chart's `ResizeObserver` never gives it a width and the
 * SVG does not render. The scrubber is measured separately by the same value, so these tests drive
 * it through the props the panel would pass rather than through layout.
 */
function renderTimeline(totalDays: number) {
  const days = Array.from({ length: totalDays }, (_, i) => day(i));
  return render(<WeatherTimeline days={days} windowDays={7} />);
}

describe('WeatherTimeline scrubber', () => {
  it('renders nothing to scroll when the whole range already fits', () => {
    renderTimeline(7);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('exposes a slider once there are earlier days to reach', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '23');
  });

  it('is reachable by keyboard, which is the only non-mouse route to the older days', () => {
    // ⚠ The chart itself is `aria-hidden` — a screen reader gets the panel's sentences, not a
    // description of 168 line segments. Without arrow keys here the earlier weather would be
    // reachable by pointer only.
    renderTimeline(30);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    expect(slider).toHaveAttribute('aria-valuetext', '1 days back');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveAttribute('aria-valuetext', 'Showing the most recent days');
  });

  it('jumps a week at a time with PageUp/PageDown and to the ends with Home/End', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(slider).toHaveAttribute('aria-valuenow', '7');

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider).toHaveAttribute('aria-valuenow', '23'); // oldest

    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider).toHaveAttribute('aria-valuenow', '0'); // newest
  });

  it('clamps at both ends rather than running past them', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowRight' }); // already newest
    expect(slider).toHaveAttribute('aria-valuenow', '0');

    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' }); // already oldest
    expect(slider).toHaveAttribute('aria-valuenow', '23');
  });

  it('ignores keys it does not own, so the panel keeps its own shortcuts', () => {
    renderTimeline(30);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    fireEvent.keyDown(slider, { key: 'a' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
  });
});
