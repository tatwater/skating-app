import { summarizeWeatherSince, type WeatherSinceSummary } from '@skating/core';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getWeather } = vi.hoisted(() => ({ getWeather: vi.fn() }));
vi.mock('convex/react', () => ({ useAction: () => getWeather }));

// Imported after the mock so its `useAction` is the stub.
const { WeatherStrip } = await import('./WeatherStrip');

function wx(partial: Partial<WeatherSinceSummary> = {}): WeatherSinceSummary {
  return { ...summarizeWeatherSince([]), hours: 24, ...partial };
}

describe('WeatherStrip', () => {
  it('renders the verdict-free line + Open-Meteo attribution', async () => {
    getWeather.mockResolvedValue(wx({ peakTempC: 5, minTempC: -5.6 }));
    render(<WeatherStrip reportId="r1" label="Weather since this report" />);

    expect(await screen.findByText(/peak 41°F · low 22°F/)).toBeInTheDocument();
    expect(screen.getByText('Weather since this report')).toBeInTheDocument();
    expect(screen.getByText('Weather: Open-Meteo')).toBeInTheDocument();
  });

  it('shows the caveat even when there is no line (snow-hidden, no weather data)', async () => {
    getWeather.mockResolvedValue(summarizeWeatherSince([])); // hours 0 ⇒ no line
    render(<WeatherStrip reportId="r1" caveat="Possibly snow-hidden." />);

    expect(await screen.findByText('Possibly snow-hidden.')).toBeInTheDocument();
  });

  it('renders nothing when there is neither a line nor a caveat', async () => {
    getWeather.mockResolvedValue(summarizeWeatherSince([]));
    const { container } = render(<WeatherStrip reportId="r1" />);

    await waitFor(() => expect(getWeather).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
