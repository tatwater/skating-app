import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFakes } from '../testMocks';
import { convexWithActions, panelFakes, resetPanelFakes } from './panelTestMocks';

vi.mock('convex/react', () => convexWithActions);
vi.mock('@skating/core', async (load) => ({
  ...(await load<typeof import('@skating/core')>()),
  formatWeatherSinceStrip: () => '18°F · NW 9 mph · no new snow',
}));

import { WeatherSince, WeatherSinceView } from './WeatherSince';

beforeEach(() => {
  resetFakes();
  resetPanelFakes();
});

describe('WeatherSinceView', () => {
  it('says nothing until there’s something to say', () => {
    const { container } = render(
      <WeatherSinceView label="Weather since this report" line={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('draws the line, its window, a caveat and the source', () => {
    render(
      <WeatherSinceView
        label="Recent weather here"
        since="Since Thursday"
        line="3 to 22°F · no new snow"
        caveat="Possibly snow-hidden."
      />,
    );
    expect(screen.getByRole('heading', { name: 'Recent weather here' })).toBeInTheDocument();
    expect(screen.getByText('Since Thursday')).toBeInTheDocument();
    expect(screen.getByText('Possibly snow-hidden.')).toBeInTheDocument();
    expect(screen.getByText('Weather: Open-Meteo')).toBeInTheDocument();
  });
});

describe('WeatherSince', () => {
  it('asks the action once, by id, and renders its summary', async () => {
    const fetch = vi.fn().mockResolvedValue({ any: 'summary' });
    panelFakes.actions.set('weather:getWeatherSinceForBody', fetch);
    render(<WeatherSince reportId="r1" label="Weather since this report" />);
    expect(await screen.findByText('18°F · NW 9 mph · no new snow')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith({ reportId: 'r1' });
  });

  it('stays quiet when the fetch fails, and drops a late answer after unmount', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('down'));
    panelFakes.actions.set('weather:getWeatherSinceForBody', fetch);
    const { container, unmount } = render(
      <WeatherSince hazardId="h1" label="Recent weather here" />,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledWith({ hazardId: 'h1' }));
    expect(container).toBeEmptyDOMElement();
    unmount();

    let resolve: (v: unknown) => void = () => {};
    panelFakes.actions.set(
      'weather:getWeatherSinceForBody',
      vi.fn(() => new Promise((r) => (resolve = r))),
    );
    const late = render(
      <WeatherSince hazardId="h1" label="Recent weather here" caveat="Possibly snow-hidden." />,
    );
    late.unmount();
    resolve({ any: 'summary' });
  });
});
