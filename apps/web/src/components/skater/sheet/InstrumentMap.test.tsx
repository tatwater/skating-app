import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InstrumentMap } from './InstrumentMap';

vi.mock('./InstrumentMapCanvas', () => ({
  default: () => <div data-testid="canvas" />,
}));

describe('InstrumentMap', () => {
  it('is a labeled region kept out of analytics, with the canvas loaded into it', async () => {
    render(
      <InstrumentMap
        input={{ polygon: null, pins: [], hazards: [], photos: [] }}
        onPick={vi.fn()}
        label="Mascoma Lake"
      />,
    );
    const region = screen.getByRole('region', { name: 'Mascoma Lake' });
    expect(region).toHaveClass('ph-no-capture');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
  });
});
