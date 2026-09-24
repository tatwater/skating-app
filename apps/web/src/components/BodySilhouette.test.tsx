import type { SilhouetteData } from '@skating/core';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BodySilhouette } from './BodySilhouette';

const SQUARE: SilhouetteData = {
  rings: [
    [
      [-73, 44],
      [-73, 44.01],
      [-72.99, 44.01],
      [-72.99, 44],
      [-73, 44],
    ],
  ],
  bbox: { minLat: 44, minLng: -73, maxLat: 44.01, maxLng: -72.99 },
  origin: { lat: 44.005, lng: -72.995 },
  middleRadiusM: 200,
};

describe('BodySilhouette (A10 §12.3)', () => {
  it('draws the outline alone when the report says nothing more', () => {
    const { container } = render(<BodySilhouette data={SQUARE} size={64} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(container.querySelectorAll('circle')).toHaveLength(0);
    // The fill, the clip, and the stroke — three copies of the outline path, nothing else.
    expect(container.querySelectorAll('path')).toHaveLength(3);
  });

  it('adds the put-in, the skate, the sector wash and the bay ring when they are there', () => {
    const { container } = render(
      <BodySilhouette
        data={{
          ...SQUARE,
          putIn: { lat: 44.001, lng: -72.999 },
          path: [
            [-72.999, 44.001],
            [-72.992, 44.008],
          ],
          sector: 'N',
          bayRing: SQUARE.rings[0],
        }}
        size={64}
      />,
    );
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    // outline ×3 + bay ring + wedge + path
    expect(container.querySelectorAll('path')).toHaveLength(6);
  });

  it('near shore is a band along the outline, not a wedge', () => {
    const { container } = render(
      <BodySilhouette data={{ ...SQUARE, sector: 'near_shore' }} size={64} />,
    );
    const stroked = [...container.querySelectorAll('path')].filter(
      (p) => p.getAttribute('stroke-width') === '10',
    );
    expect(stroked).toHaveLength(1);
  });
});
