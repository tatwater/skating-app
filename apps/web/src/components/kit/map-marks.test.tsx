import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HazardMark, LotMark, PhotoMark, PutInMark } from './map-marks';

const slot = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-slot="${name}"]`) as HTMLElement | null;

describe('marks', () => {
  it('draws a put-in at 14 px, 16 px when it’s the one in question, on a ground halo', () => {
    const { container, rerender } = render(<PutInMark />);
    const rects = () => [...container.querySelectorAll('rect')].map((r) => r.getAttribute('width'));
    expect(rects()).toEqual(['18', '14']);
    rerender(<PutInMark big />);
    expect(rects()).toEqual(['20', '16']);
    expect(container.querySelector('rect')?.getAttribute('class')).toBe('fill-(--map-ground)');
  });

  it('draws a hazard at 16 px in its tone, with brackets when chosen and receded otherwise', () => {
    const { container, rerender } = render(<HazardMark />);
    expect(container.querySelectorAll('rect')[1]?.getAttribute('class')).toBe('fill-bad');
    expect(slot(container, 'hazard-mark-brackets')).toBeNull();
    rerender(<HazardMark tone="healing" selected />);
    expect(container.querySelectorAll('rect')[1]?.getAttribute('class')).toBe('fill-warn');
    expect(slot(container, 'hazard-mark-brackets')).not.toBeNull();
    rerender(<HazardMark tone="passage" dim />);
    expect(container.querySelectorAll('rect')[1]?.getAttribute('class')).toBe('fill-acc');
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('opacity-55');
    expect(container.querySelector('svg')).toHaveAttribute('data-dim');
    // Pointed at, a hazard takes the same brackets as an open one.
    rerender(<HazardMark highlight />);
    expect(slot(container, 'hazard-mark-brackets')).not.toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('data-highlight');
  });

  it('draws a lot as a gray square with a P cut in it, in the same family', () => {
    const { container, rerender } = render(<LotMark />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('data-kind', 'lot');
    expect(svg).toHaveAttribute('width', '34');
    const rects = [...container.querySelectorAll('rect')];
    expect(rects.map((r) => r.getAttribute('width'))).toEqual(['18', '14']);
    expect(rects[1]?.getAttribute('class')).toBe('fill-fg2');
    expect(container.querySelector('path')?.getAttribute('class')).toBe('fill-bg');
    rerender(<LotMark big highlight dim />);
    expect(container.querySelectorAll('rect')[1]).toHaveAttribute('width', '16');
    expect(container.querySelector('path')?.getAttribute('transform')).toBe(`scale(${8 / 7})`);
    expect(slot(container, 'lot-mark-brackets')).not.toBeNull();
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('opacity-55');
  });

  it('draws a photo as a light square with a lens', () => {
    const { container, rerender } = render(<PhotoMark />);
    expect(container.querySelector('svg')).toHaveAttribute('data-kind', 'photo');
    expect(container.querySelectorAll('rect')[1]?.getAttribute('class')).toBe('fill-fg1');
    expect(container.querySelector('circle')?.getAttribute('class')).toBe('stroke-bg');
    rerender(<PhotoMark big />);
    expect(container.querySelectorAll('rect')[1]).toHaveAttribute('width', '14');
  });

  it('draws any mark as the key’s glyph: the face alone at 12 px, never dimmed or bracketed', () => {
    const { container } = render(<PutInMark glyph dim highlight />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '12');
    expect(svg).toHaveAttribute('viewBox', '-7 -7 14 14');
    expect(container.querySelectorAll('rect')).toHaveLength(1);
    expect(svg).not.toHaveAttribute('data-dim');
    expect(slot(container, 'put-in-mark-brackets')).toBeNull();
  });
});
