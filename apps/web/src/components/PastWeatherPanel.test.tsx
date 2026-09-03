import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getDays } = vi.hoisted(() => ({ getDays: vi.fn() }));
vi.mock('convex/react', () => ({ useAction: () => getDays }));

// Imported after the mock so its `useAction` is the stub.
const { PastWeatherPanel } = await import('./PastWeatherPanel');

/** One stored day as `getWeatherDaysForBody` returns it. */
function day(localDate: string, over: Record<string, number> = {}) {
  const [y, m, d] = localDate.split('-').map(Number);
  return {
    dayMs: Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1),
    localDate,
    hours: 24,
    minTempC: -8,
    maxTempC: -2,
    nightMinTempC: -10,
    hoursBelowFreezing: 24,
    hoursAboveFreezing: 0,
    snowfallCm: 0,
    rainMm: 0,
    hoursOfSun: 4,
    maxWindKph: 10,
    freezingHoursMeanWindKph: 3,
    ...over,
  };
}

describe('PastWeatherPanel', () => {
  it('renders the observation lines and the attribution', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-14'), day('2026-01-15'), day('2026-01-16')],
      missingDayMs: [],
      anyBorrowed: false,
    });
    render(<PastWeatherPanel waterBodyId="b1" />);

    expect(await screen.findByText("What it's been through")).toBeInTheDocument();
    expect(screen.getByText('3 nights below 20°F')).toBeInTheDocument();
    expect(screen.getByText(/Calm while freezing/)).toBeInTheDocument();
    expect(screen.getByText('Past weather: Open-Meteo')).toBeInTheDocument();
  });

  it('never renders a safety verdict or a thickness (D3 / D160)', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-14'), day('2026-01-15')],
      missingDayMs: [],
      anyBorrowed: false,
    });
    const { container } = render(<PastWeatherPanel waterBodyId="b1" />);
    await screen.findByText("What it's been through");

    const text = container.textContent ?? '';
    for (const forbidden of ['safe', 'unsafe', 'should', 'thick', 'degree-hour']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('draws a missing day as a dash rather than a zero', async () => {
    const missing = Date.UTC(2026, 0, 16);
    getDays.mockResolvedValue({
      days: [day('2026-01-14'), day('2026-01-15')],
      missingDayMs: [missing],
      anyBorrowed: false,
    });
    render(<PastWeatherPanel waterBodyId="b1" />);

    await screen.findByText("What it's been through");
    // The whole point of carrying `missing` through the archive: a hole must not read as 0°.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('1 day of weather unavailable')).toBeInTheDocument();
  });

  it('says when a day came from a wider area (D161 step 2)', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      missingDayMs: [],
      anyBorrowed: true,
    });
    render(<PastWeatherPanel waterBodyId="b1" />);
    expect(await screen.findByText(/wider area than usual/)).toBeInTheDocument();
  });

  it('renders nothing when the archive has nothing', async () => {
    getDays.mockResolvedValue({ days: [], missingDayMs: [], anyBorrowed: false });
    const { container } = render(<PastWeatherPanel waterBodyId="b1" />);
    await waitFor(() => expect(getDays).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the action returns null (unauthenticated or removed body)', async () => {
    getDays.mockResolvedValue(null);
    const { container } = render(<PastWeatherPanel waterBodyId="b1" />);
    await waitFor(() => expect(getDays).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('fails open and quiet when the action rejects', async () => {
    getDays.mockRejectedValue(new Error('offline'));
    const { container } = render(<PastWeatherPanel waterBodyId="b1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows snowfall on a day that got some', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15', { snowfallCm: 7.62 })],
      missingDayMs: [],
      anyBorrowed: false,
    });
    render(<PastWeatherPanel waterBodyId="b1" />);
    expect(await screen.findByText('3″')).toBeInTheDocument();
  });

  it('passes the requested window to the action', async () => {
    getDays.mockResolvedValue({ days: [], missingDayMs: [], anyBorrowed: false });
    render(<PastWeatherPanel days={14} waterBodyId="b1" />);
    await waitFor(() => expect(getDays).toHaveBeenCalledWith({ waterBodyId: 'b1', days: 14 }));
  });

  it('does not leave a stale panel up when the body changes', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      missingDayMs: [],
      anyBorrowed: false,
    });
    const { rerender } = render(<PastWeatherPanel waterBodyId="b1" />);
    await screen.findByText("What it's been through");

    getDays.mockResolvedValue(null);
    rerender(<PastWeatherPanel waterBodyId="b2" />);
    await waitFor(() => expect(screen.queryByText('1 night below 20°F')).not.toBeInTheDocument());
  });
});
