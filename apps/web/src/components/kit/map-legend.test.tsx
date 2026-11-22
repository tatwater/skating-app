import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MapLegend } from './map-controls';

/** The map's legend plate (`map-controls`): one row per line, each swatch drawn as the map draws it. */

describe('MapLegend', () => {
  it('lists each line with a stroke drawn as the map draws it', () => {
    const { container, getByRole } = render(
      <MapLegend
        items={[
          { label: 'Ours', ink: 'var(--fg1)', width: 1 },
          { label: 'Not ours yet', ink: 'var(--fg)', width: 1.5, dash: [4.5, 3] },
        ]}
      />,
    );
    expect(getByRole('list', { name: 'Map legend' })).toBeInTheDocument();
    const strokes = [...container.querySelectorAll('[data-slot="map-legend-swatch"] path')];
    expect(strokes.map((p) => p.getAttribute('stroke'))).toEqual(['var(--fg1)', 'var(--fg)']);
    expect(strokes[0]).not.toHaveAttribute('stroke-dasharray');
    expect(strokes[1]).toHaveAttribute('stroke-dasharray', '4.5 3');
    expect(strokes[1]).toHaveAttribute('stroke-width', '1.5');
    expect(container.querySelector('[data-slot="plate"]')).toHaveAttribute('data-variant', 'plate');
  });

  it('draws nothing with nothing to name', () => {
    expect(render(<MapLegend items={[]} />).container).toBeEmptyDOMElement();
  });
});
