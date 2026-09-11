import type { Id } from '@skating/convex/dataModel';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getForecast } = vi.hoisted(() => ({ getForecast: vi.fn() }));
vi.mock('convex/react', () => ({ useAction: () => getForecast }));

const { ForecastStrip } = await import('./ForecastStrip');

const LAKE = 'lake1' as Id<'waterBodies'>;
const OTHER = 'lake2' as Id<'waterBodies'>;

/** A 12-hour summary whose one-line form reads `Next 12 hours: lo–hi°F.` */
function summary(minC: number, maxC: number) {
  return {
    hours: Array.from({ length: 12 }, (_, i) => ({
      startMs: i * 3_600_000,
      temperatureC: minC,
      precipitationMm: 0,
      snowfallCm: 0,
    })),
    minTemperatureC: minC,
    maxTemperatureC: maxC,
  };
}

describe('ForecastStrip', () => {
  it("holds the previous bay's forecast visibly — dimmed and busy — while the next loads, then swaps", async () => {
    // Greptile on PR #50: the picker named the new bay immediately while the strip kept rendering
    // the old bay's forecast as if it were the new one. Holding it *visibly* is the fix; clearing it
    // would move the drawer's content out from under the reader's scroll position.
    let resolveNext: (v: unknown) => void = () => {};
    getForecast
      .mockResolvedValueOnce(summary(-10, -5))
      .mockImplementationOnce(() => new Promise((r) => (resolveNext = r)));
    const { rerender } = render(<ForecastStrip waterBodyId={LAKE} subAreaId="bay1" />);
    const strip = await screen.findByText(/Next 12 hours: 14–23°F/);
    expect(strip.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false');

    rerender(<ForecastStrip waterBodyId={LAKE} subAreaId="bay2" />);
    expect(screen.getByText(/14–23°F/).closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');

    resolveNext(summary(0, 4));
    await screen.findByText(/Next 12 hours: 32–39°F/);
    expect(screen.queryByText(/14–23°F/)).not.toBeInTheDocument();
    expect(screen.getByText(/32–39°F/).closest('[aria-busy]')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });

  it("drops the forecast on a different lake rather than showing another lake's under this name", async () => {
    getForecast.mockResolvedValueOnce(summary(-10, -5));
    const { rerender } = render(<ForecastStrip waterBodyId={LAKE} />);
    await screen.findByText(/14–23°F/);

    getForecast.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<ForecastStrip waterBodyId={OTHER} />);
    await waitFor(() => expect(screen.queryByText(/14–23°F/)).not.toBeInTheDocument());
  });

  it('does not fetch while the bay is still being resolved', () => {
    getForecast.mockClear();
    render(<ForecastStrip waterBodyId={LAKE} pending />);
    expect(getForecast).not.toHaveBeenCalled();
  });
});
