import { type SilhouetteData, silhouetteRings } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LakeMap } from './LakeMap';
import { WeatherCorrection } from './WeatherCorrection';

describe('WeatherCorrection (5.22)', () => {
  it('starts from the archive’s hour and stores what the author saw, as theirs', () => {
    const onChange = vi.fn();
    const onDone = vi.fn();
    render(
      <WeatherCorrection
        initial={{ airTempC: -10, windSpeedKph: 16, windDir: 'NW', sky: 'clear', source: 'user' }}
        onChange={onChange}
        onDone={onDone}
      />,
    );
    expect(screen.getByLabelText('Air °F')).toHaveValue('14');
    expect(screen.getByLabelText('Wind mph')).toHaveValue('10');
    fireEvent.change(screen.getByLabelText('Air °F'), { target: { value: '16' } });
    expect(onChange.mock.lastCall?.[0]).toMatchObject({
      windDir: 'NW',
      sky: 'clear',
      source: 'user',
    });
    expect(onChange.mock.lastCall?.[0].airTempC).toBeCloseTo(-8.89, 1);
    fireEvent.change(screen.getByLabelText('Wind mph'), { target: { value: '14' } });
    expect(onChange.mock.lastCall?.[0].windSpeedKph).toBeCloseTo(22.5, 0);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'ne ' } });
    expect(onChange.mock.lastCall?.[0].windDir).toBe('NE');
    fireEvent.click(screen.getByRole('button', { name: 'Partly cloudy' }));
    expect(onChange.mock.lastCall?.[0].sky).toBe('partly_cloudy');
    fireEvent.click(screen.getByRole('button', { name: 'Partly cloudy' }));
    expect(onChange.mock.lastCall?.[0].sky).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Snow' }));
    expect(onChange.mock.lastCall?.[0].precip).toBe('snow');
    fireEvent.click(screen.getByRole('button', { name: 'Snow' }));
    expect(onChange.mock.lastCall?.[0].precip).toBeUndefined();
    // A number the author cleared, or one that isn't a number, is left out rather than guessed.
    fireEvent.change(screen.getByLabelText('Air °F'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: ' ' } });
    expect(onChange.mock.lastCall?.[0].airTempC).toBeUndefined();
    expect(onChange.mock.lastCall?.[0].windDir).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('opens blank on an hour the archive doesn’t have', () => {
    render(<WeatherCorrection initial={{ source: 'user' }} onChange={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByLabelText('Air °F')).toHaveValue('');
    expect(screen.getByLabelText('Wind mph')).toHaveValue('');
  });
});

const square = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-72.2, 43.6],
      [-72.1, 43.6],
      [-72.1, 43.7],
      [-72.2, 43.7],
      [-72.2, 43.6],
    ],
  ],
};
const DATA: SilhouetteData = {
  ...silhouetteRings(square),
  origin: { lat: 43.65, lng: -72.15 },
  middleRadiusM: 800,
  path: [
    [-72.18, 43.62],
    [-72.12, 43.68],
  ],
};

/** The drawing is 420 × 300; the button reports that box so a click maps 1:1. */
function sized(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 420, height: 300, right: 420, bottom: 300 }) as DOMRect;
  return el;
}

describe('LakeMap (the silhouette where a where is placed off the instrument)', () => {
  it('draws the lake, its marks, the wash and the ring, without a button when nothing is pickable', () => {
    const { container } = render(
      <LakeMap
        data={DATA}
        ring
        litPins
        sector="N"
        chosenPinId="p"
        point={{ lat: 43.65, lng: -72.15, radiusMeters: 75 }}
        pins={[
          { id: 'p', lat: 43.61, lng: -72.15, label: 'Boat launch', kind: 'putIn' },
          { id: 'l', lat: 43.61, lng: -72.12, label: 'Town lot', kind: 'parking' },
        ]}
        photos={[{ id: 'ph', lat: 43.66, lng: -72.16 }]}
        hazards={[
          { id: 'h1', lat: 43.67, lng: -72.14, label: 'Open water', passage: false },
          { id: 'h2', lat: 43.68, lng: -72.13, label: 'Ridge crossing', passage: true },
        ]}
        path={DATA.path}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(container.textContent).toContain('Boat launch');
    expect(container.textContent).toContain('Open water');
    expect(container.querySelectorAll('text').length).toBeGreaterThan(8);
    render(<LakeMap data={DATA} sector="near_shore" />);
  });

  it('a click picks the launch in reach, else the ring’s sector, else the water', () => {
    const onPick = vi.fn();
    const onPickPin = vi.fn();
    const onPickSector = vi.fn();
    render(
      <LakeMap
        data={DATA}
        ring
        pins={[{ id: 'p', lat: 43.65, lng: -72.15, kind: 'putIn' }]}
        onPick={onPick}
        onPickPin={onPickPin}
        onPickSector={onPickSector}
      />,
    );
    const button = sized(screen.getByRole('button'));
    // The launch sits on the origin, the drawing's middle.
    fireEvent.click(button, { clientX: 210, clientY: 150 });
    expect(onPickPin).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }));
    // Far up the drawing, outside the ring: the north sector.
    fireEvent.click(button, { clientX: 210, clientY: 2 });
    expect(onPickSector).toHaveBeenCalledWith('N');
    // Inside the ring, off the launch: the water.
    fireEvent.click(button, { clientX: 230, clientY: 160 });
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ lat: expect.any(Number), lng: expect.any(Number) }),
    );
  });
});
