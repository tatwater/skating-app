import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InstrumentMap } from './InstrumentMap';

vi.mock('./InstrumentMapCanvas', () => ({
  default: () => <div data-testid="canvas" />,
}));

const EMPTY_INPUT = { polygon: null, pins: [], hazards: [], photos: [] };

describe('InstrumentMap', () => {
  it('is a labeled region kept out of analytics, with the canvas loaded into it', async () => {
    render(<InstrumentMap input={EMPTY_INPUT} onPick={vi.fn()} label="Mascoma Lake" />);
    const region = screen.getByRole('region', { name: 'Mascoma Lake' });
    expect(region).toHaveClass('ph-no-capture');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    // The marks' halo is the basemap's ground, as on the region map.
    expect(region.style.getPropertyValue('--map-ground')).not.toBe('');
    // Nothing drawn, nothing keyed.
    expect(screen.queryByRole('list', { name: 'Map key' })).toBeNull();
  });

  it('keys the kinds its input draws, and steps the key back in a sub-mode', () => {
    const input = {
      ...EMPTY_INPUT,
      pins: [{ id: 'l1', coord: { lat: 43.6, lng: -72.1 }, name: 'Lot', kind: 'parking' as const }],
      photos: [{ id: 'ph', coord: { lat: 43.6, lng: -72.1 } }],
    };
    const { rerender } = render(<InstrumentMap input={input} label="Mascoma Lake" />);
    const key = screen.getByRole('list', { name: 'Map key' });
    expect(key).toHaveTextContent('LotPhoto');
    expect(key).not.toHaveClass('opacity-30');
    rerender(<InstrumentMap input={input} label="Mascoma Lake" keyDim />);
    expect(screen.getByRole('list', { name: 'Map key' })).toHaveClass('opacity-30');
  });
});
