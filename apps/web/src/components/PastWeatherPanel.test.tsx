import type { Id } from '@skating/convex/dataModel';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getDays } = vi.hoisted(() => ({ getDays: vi.fn() }));
vi.mock('convex/react', () => ({ useAction: () => getDays }));

// Imported after the mock so its `useAction` is the stub.
const { PastWeatherPanel } = await import('./PastWeatherPanel');

const BODY = 'b1' as Id<'waterBodies'>;
const OTHER = 'b2' as Id<'waterBodies'>;

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
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);

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
      oneSampleForALargeBody: false,
    });
    const { container } = render(<PastWeatherPanel waterBodyId={BODY} />);
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
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);

    await screen.findByText("What it's been through");
    // The whole point of carrying `missing` through the archive: a hole must not read as 0°.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('1 day of weather unavailable')).toBeInTheDocument();
  });

  it('says so when one sample stands in for a lake too big for it', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: true,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);
    // Champlain is 170 km end to end and carries no sample grid — the panel has to say which claim
    // it is making rather than implying the reading covers the lake (D151's grammar).
    expect(
      await screen.findByText(/large enough that weather differs across it/),
    ).toBeInTheDocument();
  });

  it('stays quiet about size on an ordinary lake', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);
    await screen.findByText("What it's been through");
    expect(screen.queryByText(/large enough that weather differs/)).not.toBeInTheDocument();
  });

  it('says when a day came from a wider area (D161 step 2)', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      missingDayMs: [],
      anyBorrowed: true,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);
    expect(await screen.findByText(/wider area than usual/)).toBeInTheDocument();
  });

  it('renders nothing when the archive has nothing', async () => {
    getDays.mockResolvedValue({
      days: [],
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    const { container } = render(<PastWeatherPanel waterBodyId={BODY} />);
    await waitFor(() => expect(getDays).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the action returns null (unauthenticated or removed body)', async () => {
    getDays.mockResolvedValue(null);
    const { container } = render(<PastWeatherPanel waterBodyId={BODY} />);
    await waitFor(() => expect(getDays).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('fails open and quiet when the action rejects', async () => {
    getDays.mockRejectedValue(new Error('offline'));
    const { container } = render(<PastWeatherPanel waterBodyId={BODY} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows snowfall on a day that got some', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15', { snowfallCm: 7.62 })],
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);
    expect(await screen.findByText('3″')).toBeInTheDocument();
  });

  it('always reads the timeline range, whatever window the sentences describe', async () => {
    // ⚠ **Deliberately decoupled in N6h Workstream D, and it used to be one number.** The chart pans
    // back thirty days; the headline still describes seven, because "no snow in the last 30 days" is
    // a much rarer and quite different claim from the seven-day one, and nothing in the copy would
    // show that the window had moved. One request serves both — the archive's first touch already
    // pulls 92 days, so the wider read costs no extra fetch.
    getDays.mockResolvedValue({
      days: [],
      hours: [],
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel days={14} waterBodyId={BODY} />);
    await waitFor(() => expect(getDays).toHaveBeenCalledWith({ waterBodyId: BODY, days: 30 }));
  });

  it('scopes the sentences to the requested window, not the whole range', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      day(`2026-01-${String(i + 1).padStart(2, '0')}`),
    );
    getDays.mockResolvedValue({
      days: many,
      hours: [],
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel days={7} waterBodyId={BODY} />);
    // Seven of the thirty stored days, because that is the window the copy claims to describe.
    expect(await screen.findByText('7 nights below 20°F')).toBeInTheDocument();
  });

  it('does not leave a stale panel up when the body changes', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    const { rerender } = render(<PastWeatherPanel waterBodyId={BODY} />);
    await screen.findByText("What it's been through");

    getDays.mockResolvedValue(null);
    rerender(<PastWeatherPanel waterBodyId={OTHER} />);
    await waitFor(() => expect(screen.queryByText('1 night below 20°F')).not.toBeInTheDocument());
  });
});
