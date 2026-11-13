import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAP_KEY_ORDER, MapKey } from './map-key';

describe('MapKey', () => {
  it('draws nothing when the map draws nothing', () => {
    const { container } = render(<MapKey kinds={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists only the kinds it is given, in the key’s own order, each as its mark', () => {
    render(<MapKey kinds={['photo', 'hazard', 'putIn']} />);
    const key = screen.getByRole('list', { name: 'Map key' });
    const items = within(key).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['Put-in', 'Hazard', 'Photo']);
    // The glyphs are the map's own marks, small: the face alone, no halo.
    const glyph = items[0]?.querySelector('svg');
    expect(glyph).toHaveAttribute('data-slot', 'put-in-mark');
    expect(glyph).toHaveAttribute('width', '12');
    expect(glyph?.querySelectorAll('rect')).toHaveLength(1);
    expect(items[1]?.querySelector('svg')).toHaveAttribute('data-tone', 'danger');
  });

  it('names every kind with a noun, the lines drawn as the tracks are', () => {
    render(<MapKey kinds={MAP_KEY_ORDER} />);
    expect(screen.getAllByRole('listitem').map((i) => i.textContent)).toEqual([
      'Put-in',
      'Lot',
      'Hazard',
      'Healing hazard',
      'Ridge crossing',
      'Photo',
      'Track',
      'Your track',
    ]);
    const line = (kind: string) =>
      document.querySelector(`[data-key="${kind}"] path`)?.getAttribute('stroke-dasharray');
    expect(line('track')).toBeNull();
    expect(line('yourTrack')).not.toBeNull();
  });

  it('sits on the map’s foot, scrolls rather than wraps, and steps back when dimmed', () => {
    const { rerender } = render(<MapKey kinds={['lot']} />);
    const key = screen.getByRole('list', { name: 'Map key' });
    expect(key).toHaveClass(
      'absolute',
      'bottom-0',
      'h-7.5',
      'overflow-x-auto',
      'whitespace-nowrap',
    );
    expect(key).not.toHaveClass('opacity-30');
    rerender(<MapKey kinds={['lot']} dim />);
    expect(screen.getByRole('list', { name: 'Map key' })).toHaveClass('opacity-30');
  });
});
