import type { Id } from '@skating/convex/dataModel';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getDays } = vi.hoisted(() => ({ getDays: vi.fn() }));
vi.mock('convex/react', () => ({ useAction: () => getDays }));

// Imported after the mock so its `useAction` is the stub.
const { PastWeatherPanel } = await import('./PastWeatherPanel');

const BODY = 'b1' as Id<'waterBodies'>;
const OTHER = 'b2' as Id<'waterBodies'>;

/**
 * A "today" past every fixture, so the fixtures read as settled days.
 *
 * ⚠ The action serves this now: today's archive row holds 24 hours with the un-elapsed ones
 * forecast, so a client cannot tell a finished day from one still happening without being told.
 */
const TODAY = Date.UTC(2030, 0, 1);

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

/**
 * Wait for the panel to have *loaded*, not merely mounted. The heading renders in the "Reading…"
 * state too, so waiting on it resolves before the mocked action does — and a synchronous assertion
 * after that races the promise, which a slow CI runner lost (PR #53). The loading line going away
 * is the signal that the data landed.
 */
async function awaitLoaded() {
  await screen.findByText("What it's been through");
  await waitFor(() => expect(screen.queryByText(/Reading the last/)).not.toBeInTheDocument());
}

describe('PastWeatherPanel', () => {
  it('renders the observation lines and the attribution', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-14'), day('2026-01-15'), day('2026-01-16')],
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);

    await awaitLoaded();
    // No served chain in this mock, so the panel computes over its own three days — all cold, and
    // reaching the window's edge, hence the "+" (D164).
    expect(screen.getByText('3+ nights below 20°F, no snow since the first')).toBeInTheDocument();
    expect(screen.getByText(/Calm while freezing/)).toBeInTheDocument();
    expect(screen.getByText('Past weather: Open-Meteo')).toBeInTheDocument();
  });

  it('prints the served chain over the panel window when the action supplies one (D164)', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-14'), day('2026-01-15'), day('2026-01-16')],
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
      chain: {
        thresholdF: 20,
        nights: 22,
        startDayMs: Date.UTC(2025, 11, 26),
        endDayMs: Date.UTC(2026, 0, 16),
        coldNightMask: 2 ** 22 - 1,
        alive: true,
        openEnded: false,
        snowSinceStartCm: 3,
        snowUnknownDays: 0,
        asOfDayMs: Date.UTC(2026, 0, 16),
      },
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);
    expect(
      await screen.findByText('22 nights below 20°F, 1.2 in of snow since the first'),
    ).toBeInTheDocument();
  });

  it('never renders a safety verdict or a thickness (D3 / D160)', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-14'), day('2026-01-15')],
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    const { container } = render(<PastWeatherPanel waterBodyId={BODY} />);
    await awaitLoaded();

    const text = container.textContent ?? '';
    for (const forbidden of ['safe', 'unsafe', 'should', 'thick', 'degree-hour']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('draws a missing day as a dash rather than a zero', async () => {
    const missing = Date.UTC(2026, 0, 16);
    getDays.mockResolvedValue({
      days: [day('2026-01-14'), day('2026-01-15')],
      todayLocalDayMs: TODAY,
      missingDayMs: [missing],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);

    await awaitLoaded();
    // The whole point of carrying `missing` through the archive: a hole must not read as 0°.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('1 day of weather unavailable')).toBeInTheDocument();
  });

  it('says so when one sample stands in for a lake too big for it', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      todayLocalDayMs: TODAY,
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
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel waterBodyId={BODY} />);
    await awaitLoaded();
    expect(screen.queryByText(/large enough that weather differs/)).not.toBeInTheDocument();
  });

  it('says when a day came from a wider area (D161 step 2)', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      todayLocalDayMs: TODAY,
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
      todayLocalDayMs: TODAY,
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
      todayLocalDayMs: TODAY,
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
      todayLocalDayMs: TODAY,
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
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    render(<PastWeatherPanel days={7} waterBodyId={BODY} />);
    // Seven of the thirty stored days, because that is the window the copy claims to describe.
    expect(
      await screen.findByText('7+ nights below 20°F, no snow since the first'),
    ).toBeInTheDocument();
  });

  it('does not leave a stale panel up when the body changes', async () => {
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    const { rerender } = render(<PastWeatherPanel waterBodyId={BODY} />);
    await awaitLoaded();

    getDays.mockResolvedValue(null);
    rerender(<PastWeatherPanel waterBodyId={OTHER} />);
    await waitFor(() => expect(screen.queryByText('1 night below 20°F')).not.toBeInTheDocument());
  });

  it('asks for the bay it was given, and holds while the bay is still unknown', async () => {
    // Open question 5: on a giant the panel is about a named bay, and the caller resolves which.
    getDays.mockClear();
    getDays.mockResolvedValue({
      days: [day('2026-01-15')],
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
      scope: { kind: 'subArea', subAreaId: 'bay1', name: 'Malletts Bay' },
    });
    // `pending` = the bays have not loaded: no fetch, or a giant would pay for the lake's cell and
    // then the bay's on the same drawer-open.
    const { rerender } = render(<PastWeatherPanel waterBodyId={BODY} pending />);
    expect(getDays).not.toHaveBeenCalled();
    expect(screen.getByText(/Reading the last/)).toBeInTheDocument();

    rerender(<PastWeatherPanel waterBodyId={BODY} subAreaId="bay1" />);
    await screen.findByText(/Past weather: Open-Meteo/);
    expect(getDays).toHaveBeenCalledTimes(1);
    expect(getDays.mock.calls[0]?.[0]).toMatchObject({ waterBodyId: BODY, subAreaId: 'bay1' });

    // No bay = the lake itself: fetches, and sends no bay.
    rerender(<PastWeatherPanel waterBodyId={BODY} />);
    await waitFor(() => expect(getDays).toHaveBeenCalledTimes(2));
    expect(getDays.mock.calls[1]?.[0]).not.toHaveProperty('subAreaId');
  });

  it("keeps the previous bay's reading on screen while the next one loads, and clears on a new lake", async () => {
    // Blanking to "Reading…" on a bay switch removed the timeline from under the reader's scroll
    // position; the drawer clamped to the top and they were looking at the buttons.
    let resolveNext: (v: unknown) => void = () => {};
    getDays.mockClear();
    getDays
      .mockResolvedValueOnce({
        days: [day('2026-01-15')],
        todayLocalDayMs: TODAY,
        missingDayMs: [],
        anyBorrowed: false,
        oneSampleForALargeBody: false,
      })
      .mockImplementationOnce(() => new Promise((r) => (resolveNext = r)));
    const { rerender } = render(<PastWeatherPanel waterBodyId={BODY} subAreaId="bay1" />);
    await screen.findByText(/Past weather: Open-Meteo/);

    rerender(<PastWeatherPanel waterBodyId={BODY} subAreaId="bay2" />);
    // Still up, dimmed and marked busy — not the one-line loading state.
    expect(screen.queryByText(/Reading the last/)).not.toBeInTheDocument();
    expect(screen.getByText(/Past weather: Open-Meteo/).closest('[aria-busy]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    resolveNext({
      days: [day('2026-01-15', { minTempC: -20 })],
      todayLocalDayMs: TODAY,
      missingDayMs: [],
      anyBorrowed: false,
      oneSampleForALargeBody: false,
    });
    await waitFor(() =>
      expect(screen.getByText(/Past weather/).closest('[aria-busy]')).toHaveAttribute(
        'aria-busy',
        'false',
      ),
    );

    // A different lake is a different page: the held reading must not survive it.
    getDays.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<PastWeatherPanel waterBodyId={OTHER} subAreaId="bay9" />);
    expect(screen.getByText(/Reading the last/)).toBeInTheDocument();
    expect(screen.queryByText(/Past weather: Open-Meteo/)).not.toBeInTheDocument();
  });
});
