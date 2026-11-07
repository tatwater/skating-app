import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PastWeatherChart, TimelineSlider } from './PastWeatherChart';
import { deriveForecast } from './useWeatherData';
import { AcrossTheLakeView, ForecastPlanner, ForecastView, PastWeatherView } from './WeatherViews';
import { forecastPayload, forecastPlan, NOW_MS, SPREAD, timelineDays } from './weatherFixtures';

let width = 384;

beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  width = 384;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width } }]);
      }
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-mode');
});

/** The chart's host: the element carrying the pointer handlers. */
const host = (container: HTMLElement) =>
  container.querySelector('[data-slot="past-weather-chart"] > div') as HTMLElement;

function stubRect(el: HTMLElement, left = 0, w = width) {
  el.getBoundingClientRect = () =>
    ({
      left,
      top: 0,
      width: w,
      height: 260,
      right: left + w,
      bottom: 260,
      x: left,
      y: 0,
    }) as DOMRect;
}

describe('PastWeatherChart', () => {
  it('draws the lanes, the day numbers and the month under them', () => {
    const { container } = render(<PastWeatherChart days={timelineDays()} />);
    const text = container.textContent ?? '';
    for (const lane of ['Precip', 'Wind', 'Sun', 'Snow', '32°', 'January', '16']) {
      expect(text).toContain(lane);
    }
    // The drawing is decoration to a reader; the slider is the keyboard's way back.
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.getByRole('slider', { name: 'Scroll the weather chart through time' }),
    ).toBeTruthy();
  });

  it('gives each chart its own gradient, so two on a page each paint in their own theme', () => {
    const { container } = render(
      <>
        <PastWeatherChart days={timelineDays()} />
        <PastWeatherChart days={timelineDays()} />
      </>,
    );
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('draws nothing for no days, and no slider when everything fits', () => {
    const { container, unmount } = render(<PastWeatherChart days={[]} />);
    expect(container.innerHTML).toBe('');
    unmount();
    width = 2000;
    render(<PastWeatherChart days={timelineDays().slice(-2)} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('scrubs: a readout in words beside the line, gone when the pointer leaves', () => {
    const { container } = render(<PastWeatherChart days={timelineDays()} />);
    const el = host(container);
    stubRect(el);
    fireEvent.pointerMove(el, { clientX: 360 });
    const readout = screen.getByRole('status');
    expect(readout.textContent).toMatch(/Sat 16 · /);
    expect(readout.textContent).toMatch(/°F/);
    // Over the gutter there is no hour.
    fireEvent.pointerMove(el, { clientX: 10 });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.pointerMove(el, { clientX: 60 });
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.pointerLeave(el);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('pans by drag (right is back in time) and by a horizontal wheel only', () => {
    const { container } = render(<PastWeatherChart days={timelineDays()} />);
    const el = host(container);
    const slider = screen.getByRole('slider');
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 148, pointerId: 1 });
    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(slider.getAttribute('aria-valuetext')).toBe('1.0 days back');
    // A vertical wheel belongs to the sidebar.
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 40, cancelable: true }));
    expect(slider.getAttribute('aria-valuetext')).toBe('1.0 days back');
    act(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: 48, deltaY: 0, cancelable: true }));
    });
    expect(slider.getAttribute('aria-valuetext')).toBe('Showing the most recent days');
  });

  it('follows the theme it sits in', () => {
    document.documentElement.setAttribute('data-mode', 'light');
    const { container } = render(<PastWeatherChart days={timelineDays()} />);
    const stops = [...container.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'));
    expect(stops).toContain('#075985');
  });
});

describe('TimelineSlider', () => {
  const geometry = { maxScrollPx: 960, viewportWidth: 344, contentWidth: 1304, trackWidth: 344 };

  it('steps a day per arrow and a week per page; Home and End jump to the ends', () => {
    const onScroll = vi.fn();
    render(<TimelineSlider scrollPx={96} onScroll={onScroll} {...geometry} />);
    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('aria-valuetext')).toBe('2.0 days back');
    const keys = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'a'];
    for (const key of keys) fireEvent.keyDown(slider, { key });
    expect(onScroll.mock.calls.map((c) => c[0])).toEqual([144, 48, 432, 0, 960, 0]);
  });

  it('seeks where the track is pressed and dragged', () => {
    const onScroll = vi.fn();
    render(<TimelineSlider scrollPx={0} onScroll={onScroll} {...geometry} />);
    const slider = screen.getByRole('slider');
    slider.getBoundingClientRect = () => ({ left: 0, width: 344 }) as DOMRect;
    fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 344, pointerId: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 100, pointerId: 1 });
    expect(onScroll).toHaveBeenCalledTimes(2);
    expect(onScroll.mock.calls[0]?.[0]).toBeGreaterThan(onScroll.mock.calls[1]?.[0]);
    // A track with no size can't be aimed at.
    slider.getBoundingClientRect = () => ({ left: 0, width: 0 }) as DOMRect;
    fireEvent.pointerDown(slider, { clientX: 5, pointerId: 1 });
    expect(onScroll).toHaveBeenCalledTimes(2);
  });
});

describe('ForecastPlanner', () => {
  const plan = forecastPlan();

  it('opens at now, marks the arrival card, and names the drive as a band', () => {
    render(<ForecastPlanner plan={plan} />);
    const hours = within(screen.getByRole('list', { name: 'Hourly forecast' })).getAllByRole(
      'listitem',
    );
    expect(hours[0]?.getAttribute('aria-label')).toMatch(/^Now, /);
    expect(hours[1]?.getAttribute('aria-label')).toMatch(/about when you would arrive$/);
    expect(screen.getByText('≈ arrival, 60 min drive, if you left now')).toBeTruthy();
    expect(screen.getAllByText('NW 8').length).toBeGreaterThan(0);
  });

  it('a day card scrolls the hours to its morning; scrolling the hours picks the day', () => {
    render(<ForecastPlanner plan={plan} />);
    const days = within(screen.getByRole('group', { name: 'Daily forecast' })).getAllByRole(
      'button',
    );
    expect(days[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(days[1]?.getAttribute('aria-label')).toMatch(/^Tomorrow, Sun 17, high /);
    fireEvent.click(days[1] as HTMLElement);
    expect(days[1]?.getAttribute('aria-pressed')).toBe('true');

    // jsdom has no layout: lay the cards out 70 px apart, then scroll to Tuesday's first hour.
    const list = screen.getByRole('list', { name: 'Hourly forecast' });
    const cards = within(list).getAllByRole('listitem');
    cards.forEach((c, i) => {
      Object.defineProperty(c, 'offsetLeft', { value: i * 70, configurable: true });
      Object.defineProperty(c, 'offsetWidth', { value: 64, configurable: true });
    });
    const tue = plan.days[3];
    if (!tue) throw new Error('expected Tuesday');
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    list.scrollLeft = tue.firstHourIndex * 70;
    fireEvent.scroll(list);
    expect(days[3]?.getAttribute('aria-pressed')).toBe('true');
    vi.restoreAllMocks();
  });

  it('ignores its own scroll while a chosen day is still settling', () => {
    render(<ForecastPlanner plan={plan} />);
    const list = screen.getByRole('list', { name: 'Hourly forecast' });
    const days = within(screen.getByRole('group', { name: 'Daily forecast' })).getAllByRole(
      'button',
    );
    fireEvent.click(days[2] as HTMLElement);
    list.scrollLeft = 0;
    fireEvent.scroll(list);
    expect(days[2]?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the views', () => {
  it('ForecastView: a frame while loading, the honest absence with no forecast', () => {
    const { container, rerender } = render(
      <ForecastView loading refreshing={false} line={null} plan={null} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    rerender(<ForecastView loading={false} refreshing={false} line={null} plan={null} />);
    expect(screen.getByText(/^No forecast recorded/)).toBeTruthy();
    const derived = deriveForecast(forecastPayload(), NOW_MS);
    rerender(<ForecastView loading refreshing line={derived.line} plan={derived.plan} />);
    expect(screen.getByText(derived.line as string)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'What’s coming' }).getAttribute('aria-busy')).toBe(
      'true',
    );
  });

  it('PastWeatherView: draws nothing with nothing honest to say; sentences without hours', () => {
    const base = {
      loading: false,
      refreshing: false,
      timeline: [],
      largeBody: false,
      coarse: false,
    };
    const { container, rerender } = render(<PastWeatherView {...base} headline={[]} />);
    expect(container.innerHTML).toBe('');
    rerender(<PastWeatherView {...base} headline={['Rain on Jan 8']} />);
    expect(screen.getByText('Rain on Jan 8')).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('button', { name: 'Last 10 days' })).toBeTruthy();
  });

  it('AcrossTheLakeView: the one-liner when the bays agree, and the rankings', () => {
    const link = (id: string) => ({ href: `/water/m?sub=${id}`, onClick: vi.fn() });
    render(
      <AcrossTheLakeView
        spread={{
          ...SPREAD,
          similar: true,
          summary: 'About the same across both bays',
          rankings: {
            coldestNights: {
              kind: 'coldestNights',
              label: 'Bays by coldest nights',
              bays: [
                { subAreaId: 'north', name: 'Mascoma North', value: '4 nights' },
                { subAreaId: 'south', name: 'Mascoma South', value: '2 nights' },
              ],
            },
            leastSnow: null,
          },
        }}
        bayHref={link}
      />,
    );
    expect(screen.getByText('About the same across both bays')).toBeTruthy();
    expect(screen.queryByText(/coldest at/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Mascoma South' }).getAttribute('href')).toBe(
      '/water/m?sub=south',
    );
  });
});
