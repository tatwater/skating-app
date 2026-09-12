import type { Id } from '@skating/convex/dataModel';
import type { ForecastHour, ForecastPayload } from '@skating/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getForecast } = vi.hoisted(() => ({ getForecast: vi.fn() }));
vi.mock('convex/react', () => ({ useAction: () => getForecast }));

const { ForecastPanel, ForecastPlanner } = await import('./ForecastPanel');
const { buildForecastPlan } = await import('@skating/core');

const LAKE = 'lake1' as Id<'waterBodies'>;
const OTHER = 'lake2' as Id<'waterBodies'>;
const HOUR = 3_600_000;
/** Fix the clock at a Wednesday 2 PM UTC; the fixture's offset is zero so local == UTC. */
const NOW = Date.UTC(2026, 0, 14, 14, 0);

/** `hours` forward hours from now at a flat temperature, with an optional shaper. */
function payload(
  minC: number,
  maxC: number,
  hours = 12,
  shape: (i: number) => Partial<ForecastHour> = () => ({}),
): ForecastPayload {
  return {
    utcOffsetMs: 0,
    arrivalBandMinutes: null,
    hours: Array.from({ length: hours }, (_, i) => ({
      startMs: NOW + (i + 1) * HOUR,
      temperatureC: i === 0 ? minC : maxC,
      windSpeedKph: 10,
      precipitationMm: 0,
      snowfallCm: 0,
      weatherCode: 1,
      shortwaveWm2: 100,
      ...shape(i),
    })),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ForecastPanel', () => {
  it("holds the previous bay's forecast visibly — dimmed and busy — while the next loads, then swaps", async () => {
    // Greptile on PR #50: the picker named the new bay immediately while the strip kept rendering
    // the old bay's forecast as if it were the new one. Holding it *visibly* is the fix; clearing it
    // would move the drawer's content out from under the reader's scroll position.
    let resolveNext: (v: unknown) => void = () => {};
    getForecast
      .mockResolvedValueOnce(payload(-10, -5))
      .mockImplementationOnce(() => new Promise((r) => (resolveNext = r)));
    const { rerender } = render(<ForecastPanel waterBodyId={LAKE} subAreaId="bay1" />);
    const strip = await screen.findByText(/Next 12 hours: 14–23°F/);
    expect(strip.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false');

    rerender(<ForecastPanel waterBodyId={LAKE} subAreaId="bay2" />);
    expect(screen.getByText(/14–23°F/).closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');

    resolveNext(payload(0, 4));
    await screen.findByText(/Next 12 hours: 32–39°F/);
    expect(screen.queryByText(/14–23°F/)).not.toBeInTheDocument();
    expect(screen.getByText(/32–39°F/).closest('[aria-busy]')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });

  it("drops the forecast on a different lake rather than showing another lake's under this name", async () => {
    getForecast.mockResolvedValueOnce(payload(-10, -5));
    const { rerender } = render(<ForecastPanel waterBodyId={LAKE} />);
    await screen.findByText(/14–23°F/);

    getForecast.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<ForecastPanel waterBodyId={OTHER} />);
    await waitFor(() => expect(screen.queryByText(/14–23°F/)).not.toBeInTheDocument());
  });

  it('does not fetch while the bay is still being resolved', () => {
    getForecast.mockClear();
    render(<ForecastPanel waterBodyId={LAKE} pending />);
    expect(getForecast).not.toHaveBeenCalled();
  });

  it('draws an hour card per forward hour and a day card per day, with the strip line as the headline', async () => {
    getForecast.mockResolvedValueOnce(payload(-10, -5, 30));
    render(<ForecastPanel waterBodyId={LAKE} />);
    await screen.findByText(/Next 12 hours/);
    expect(screen.getByRole('list', { name: 'Hourly forecast' }).children).toHaveLength(30);
    // 3 PM Wed → 8 PM Thu spans two local days.
    expect(
      within(screen.getByRole('group', { name: 'Daily forecast' })).getAllByRole('button'),
    ).toHaveLength(2);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
  });

  it('prints the episode sentence on the day it starts — "Snow 10 PM–4 AM"', async () => {
    // Hours 1..30 from 3 PM Wed; snow on 10 PM Wed (i=7) through 3 AM Thu (i=12) at 0.5 cm each.
    getForecast.mockResolvedValueOnce(
      payload(-10, -5, 30, (i) => (i >= 7 && i <= 12 ? { weatherCode: 73, snowfallCm: 0.5 } : {})),
    );
    render(<ForecastPanel waterBodyId={LAKE} />);
    await screen.findByText('Snow 10 PM–4 AM Thu · 1.2″');
  });

  it('captions the arrival card as a band, never as a time', async () => {
    getForecast.mockResolvedValueOnce({ ...payload(-10, -5), arrivalBandMinutes: 60 });
    render(<ForecastPanel waterBodyId={LAKE} />);
    await screen.findByText(/≈ arrival, 60 min drive, if you left now/);
    expect(
      screen.getByRole('listitem', { name: /about when you would arrive/ }),
    ).toBeInTheDocument();
  });

  it('states the absence under the reveal flag instead of rendering nothing', async () => {
    getForecast.mockResolvedValueOnce(null);
    render(<ForecastPanel waterBodyId={LAKE} reveal />);
    await screen.findByText(/No forecast recorded/);
  });
});

describe('ForecastPlanner', () => {
  it('selects the tapped day and scrolls the hour row to its first card', () => {
    const plan = buildForecastPlan(payload(-10, -5, 48).hours, NOW);
    render(<ForecastPlanner plan={plan} />);
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
    const hourList = screen.getByRole('list', { name: 'Hourly forecast' });
    hourList.scrollTo = vi.fn();
    const tomorrow = screen.getByText('Tomorrow').closest('button')!;
    expect(tomorrow).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tomorrow);
    expect(tomorrow).toHaveAttribute('aria-pressed', 'true');
    expect(hourList.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });
});
