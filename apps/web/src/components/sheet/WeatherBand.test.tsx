import { emptySheet, type SheetReport, type WindowHour } from '@skating/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WeatherBand } from './WeatherBand';

const TZ = 'America/New_York';
const local = (h: number) => Date.UTC(2026, 0, 10, h + 5);
const hour = (h: number, over: Partial<WindowHour> = {}): WindowHour => ({
  localHour: h,
  startMs: local(h),
  temperatureC: -7,
  windSpeedKph: 13,
  windDirectionDeg: 315,
  ...over,
});
const report: SheetReport = {
  id: 'r1',
  idempotencyKey: 'k',
  sheet: emptySheet(local(16), 'wb1'),
  photos: [],
  keptPhotoIds: [],
  bundleCandidateIds: [],
  unbundledHazardIds: [],
};
const sun = { sunriseMs: local(7), sunsetMs: local(16) + 31 * 60_000 };

describe('WeatherBand', () => {
  it('draws one card per hour the skate touched and says what the weather did', () => {
    const hours = [hour(13), hour(14), hour(15, { temperatureC: -8, windSpeedKph: 19 }), hour(17)];
    render(
      <WeatherBand
        hours={hours}
        windowHours={hours.slice(1, 3)}
        endMs={local(15) + 30 * 60_000}
        timeZone={TZ}
        sun={sun}
        fractionOf={(ms) => (ms - local(12)) / (6 * 3600_000)}
        report={report}
        dispatch={() => {}}
      />,
    );
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAccessibleName('2 PM, Clear, 19°F, wind NW 8 mph');
    expect(screen.getByText('19→18 °F')).toBeInTheDocument();
    expect(screen.getByText('wind NW 8→12 mph')).toBeInTheDocument();
    expect(screen.getByText('clear')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Correct it/ })).toBeInTheDocument();
  });

  it('says why there is nothing: no end time, the archive still reading, no hours', () => {
    const { rerender } = render(
      <WeatherBand
        hours={null}
        windowHours={[]}
        endMs={undefined}
        timeZone={TZ}
        sun={null}
        fractionOf={() => 0}
        report={report}
        dispatch={() => {}}
      />,
    );
    expect(screen.getByText(/Set when you got off/)).toBeInTheDocument();
    rerender(
      <WeatherBand
        hours={null}
        windowHours={[]}
        endMs={local(15)}
        timeZone={TZ}
        sun={null}
        fractionOf={() => 0}
        report={report}
        dispatch={() => {}}
      />,
    );
    expect(screen.getByText(/Reading the archive/)).toBeInTheDocument();
    rerender(
      <WeatherBand
        hours={[]}
        windowHours={[]}
        endMs={local(15)}
        timeZone={TZ}
        sun={null}
        fractionOf={() => 0}
        report={report}
        dispatch={() => {}}
      />,
    );
    expect(screen.getByText(/No archived weather/)).toBeInTheDocument();
  });
});
