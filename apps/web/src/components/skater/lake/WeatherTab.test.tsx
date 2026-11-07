import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

/** Each action's answer, by function name; a function gets the args. */
const actions = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());
const stable = vi.hoisted(() => new Map<string, (args: unknown) => Promise<unknown>>());

vi.mock('convex/react', () => ({
  ...convexReact,
  // Stable per function, as Convex's own is: an effect keyed on it must not re-run every render.
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    let fn = stable.get(name);
    if (!fn) {
      fn = (args: unknown) => {
        fakes.calls.push({ name, args });
        const answer = actions.get(name);
        return answer ? answer(args) : Promise.resolve(null);
      };
      stable.set(name, fn);
    }
    return fn;
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: fakes.push, replace: vi.fn() } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: fakes.location }),
}));

import { WeatherTab } from './WeatherTab';
import { archiveResult, BAYS, forecastPayload, NOW_MS, SPREAD } from './weather/weatherFixtures';

const PAST = 'weatherArchive:getWeatherDaysForBody';
const FORECAST = 'weather:getForecastForBody';

beforeAll(() => {
  // jsdom has no Web Animations; the kit skeleton and Base UI ask for them.
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  // Only the clock: the forecast is read against the board's "now" (the arrival card).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  resetFakes();
  actions.clear();
  fakes.location = { pathname: '/water/mascoma', searchStr: '?tab=weather' };
  // A fixed width so the chart lays out (jsdom has no layout).
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width: 384 } }]);
      }
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function answer(bays: unknown[] = []) {
  fakes.queries.set('subAreas:listForBody', bays);
  fakes.queries.set('weatherArchive:getSubAreaSpread', SPREAD);
  actions.set(PAST, () => Promise.resolve(archiveResult()));
  actions.set(FORECAST, () => Promise.resolve(forecastPayload()));
}

const callsTo = (name: string) => fakes.calls.filter((c) => c.name === name);

describe('WeatherTab', () => {
  it('reads one sample point with no "Weather at" on a lake without bays', async () => {
    answer([]);
    render(<WeatherTab waterBodyId="mascoma" />);
    await screen.findByText('Rain on Jan 8');
    expect(screen.queryByText('Weather at')).toBeNull();
    // No bays: no spread asked for.
    expect(callsTo('weatherArchive:getSubAreaSpread')).toHaveLength(0);
    expect(callsTo(PAST)[0]?.args).toEqual({ waterBodyId: 'mascoma', days: 30 });
    expect(callsTo(FORECAST)[0]?.args).toEqual({ waterBodyId: 'mascoma' });
    // The order is an authority claim: observation above forecast.
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(['What it’s been through', 'What’s coming']);
    await screen.findByRole('list', { name: 'Hourly forecast' });
    expect(screen.getByText('Past weather: Open-Meteo')).toBeTruthy();
    expect(screen.getByText('Forecast: Open-Meteo')).toBeTruthy();
    expect(screen.getByText(/≈ arrival, 60 min drive, if you left now/)).toBeTruthy();
  });

  it('offers "Weather at" with the whole lake and each bay, and reads the bay in view', async () => {
    answer(BAYS);
    render(<WeatherTab waterBodyId="mascoma" subAreaId="north" />);
    await screen.findByText('Rain on Jan 8');
    const select = screen.getByRole('combobox', {
      name: 'Which part of the lake the weather is for',
    });
    expect(select.textContent).toContain('Mascoma North');
    expect(callsTo(PAST)[0]?.args).toEqual({
      waterBodyId: 'mascoma',
      days: 30,
      subAreaId: 'north',
    });
    // Two bays: the spread, with its bays as links to `?sub=`.
    const across = screen.getByRole('region', { name: 'Across the lake' });
    const south = within(across).getByRole('link', { name: 'Mascoma South' });
    expect(south.getAttribute('href')).toBe('/water/mascoma?tab=weather&sub=south');
    fireEvent.click(south);
    expect(fakes.push).toHaveBeenCalledWith('/water/mascoma?tab=weather&sub=south');
  });

  it('choosing a place is a navigation to `?sub=`', async () => {
    answer(BAYS);
    render(<WeatherTab waterBodyId="mascoma" />);
    const select = await screen.findByRole('combobox', {
      name: 'Which part of the lake the weather is for',
    });
    expect(select.textContent).toContain('Whole lake');
    fireEvent.click(select);
    const option = await screen.findByRole('option', { name: 'Mascoma South' });
    // Base UI ignores a press in the first moments after opening (so the opening press can't land
    // on an item); wait it out, then highlight the item and choose it from the keyboard.
    await act(() => new Promise((r) => setTimeout(r, 450)));
    fireEvent.mouseMove(option);
    fireEvent.keyDown(option, { key: 'Enter' });
    expect(fakes.push).toHaveBeenCalledWith('/water/mascoma?tab=weather&sub=south');
  });

  it('draws the loading frames, then fails open and quiet', async () => {
    answer([]);
    actions.set(PAST, () => Promise.reject(new Error('down')));
    actions.set(FORECAST, () => Promise.reject(new Error('down')));
    const { container } = render(<WeatherTab waterBodyId="mascoma" />);
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
    await waitFor(() => expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0));
    // No history: the section goes; no forecast: the honest absence.
    expect(screen.queryByText('What it’s been through')).toBeNull();
    expect(screen.getByText(/^No forecast recorded/)).toBeTruthy();
  });

  it('a refused read (signed out) draws nothing for the past', async () => {
    answer([]);
    actions.set(PAST, () => Promise.resolve(null));
    render(<WeatherTab waterBodyId="mascoma" />);
    await screen.findByRole('list', { name: 'Hourly forecast' });
    expect(screen.queryByText('What it’s been through')).toBeNull();
  });

  it('keeps the reading up, dimmed, across a bay switch; drops it across a lake switch', async () => {
    answer(BAYS);
    let release: (v: unknown) => void = () => {};
    const { rerender } = render(<WeatherTab waterBodyId="mascoma" />);
    await screen.findByText('Rain on Jan 8');
    actions.set(PAST, () => new Promise((r) => (release = r)));
    rerender(<WeatherTab waterBodyId="mascoma" subAreaId="south" />);
    const section = screen.getByRole('region', { name: 'What it’s been through' });
    await waitFor(() => expect(section.getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByText('Rain on Jan 8')).toBeTruthy();
    await act(async () => release(archiveResult()));
    await waitFor(() => expect(section.getAttribute('aria-busy')).toBeNull());

    actions.set(PAST, () => new Promise(() => {}));
    rerender(<WeatherTab waterBodyId="crystal" />);
    await waitFor(() => expect(screen.queryByText('Rain on Jan 8')).toBeNull());
  });

  it('states the caveats in the old panels’ words', async () => {
    answer([]);
    actions.set(PAST, () =>
      Promise.resolve({ ...archiveResult(), anyBorrowed: true, oneSampleForALargeBody: true }),
    );
    render(<WeatherTab waterBodyId="mascoma" />);
    expect(
      await screen.findByText(
        'This lake is large enough that weather differs across it — these readings are from one point near the middle.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Some days are from a wider area than usual.')).toBeTruthy();
  });
});
