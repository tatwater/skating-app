import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DepthLegend } from './DepthLegend';
import { LakeLabel } from './LakeLabel';
import { HazardMark, LotMark, PhotoMark, PutInMark } from './MapMarks';

const slot = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-slot="${name}"]`) as HTMLElement | null;

describe('LakeLabel', () => {
  it('draws the lockup: slug over name, 18 px right of the anchor, its top at −53', () => {
    const { container } = render(<LakeLabel name="Mascoma Lake" slug="3 reports · today" />);
    expect(screen.getByText('Mascoma Lake')).toBeInTheDocument();
    expect(screen.getByText('3 reports · today')).toBeInTheDocument();
    const lockup = slot(container, 'lake-label-lockup');
    expect(lockup?.style.top).toBe('-53px');
    expect(lockup?.style.left).toBe('18px');
    expect(slot(container, 'lake-label')?.className).toContain('pointer-events-none');
  });

  it('sits a name alone at −34', () => {
    const { container } = render(<LakeLabel name="George Pond" slug={null} />);
    expect(slot(container, 'lake-label-slug')).toBeNull();
    expect(slot(container, 'lake-label-lockup')?.style.top).toBe('-34px');
  });

  it('mirrors: lockup right-aligned 18 px left of the anchor, the leader flipped', () => {
    const { container } = render(<LakeLabel name="Crystal Lake" slug={null} mirrored />);
    const lockup = slot(container, 'lake-label-lockup');
    expect(lockup?.style.right).toBe('18px');
    expect(lockup?.className).toContain('items-end');
    expect(slot(container, 'lake-label')).toHaveAttribute('data-mirrored');
  });

  it('draws a gold star for a favorite and an outline badge saying how many open bounties', () => {
    render(<LakeLabel name="Smith Pond" slug={null} favorite openBounties={3} />);
    expect(
      screen.getByRole('img', { name: 'A favorite' }).querySelector('svg')?.getAttribute('class'),
    ).toContain('text-star');
    const badge = screen.getByRole('img', { name: '3 open bounties' });
    expect(badge).toHaveTextContent('3');
    expect(badge.className).toContain('border-fg');
    expect(badge.className).not.toMatch(/\bbg-fg\b/);
  });

  it('draws no star or badge when there is none to draw', () => {
    render(<LakeLabel name="Halfmile Pond" slug={null} openBounties={0} />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('grays an inactive body and recedes a dimmed one', () => {
    const { container, rerender } = render(
      <LakeLabel name="George Pond" slug="Inactive" inactive />,
    );
    expect(slot(container, 'lake-label-slug')?.className).toContain('bg-fg3');
    expect(slot(container, 'lake-label-name')?.className).toContain('text-fg2');
    expect(container.querySelector('circle')?.getAttribute('class')).toBe('fill-fg2');
    rerender(<LakeLabel name="Crystal Lake" slug="1 report · Tuesday" dim />);
    expect(slot(container, 'lake-label-slug')?.className).toContain('bg-fg2');
    rerender(<LakeLabel name="Crystal Lake" slug="1 report · Tuesday" />);
    expect(slot(container, 'lake-label-slug')?.className).toContain('bg-fg1');
    expect(container.querySelector('circle')?.getAttribute('class')).toBe('fill-fg');
  });

  it('gives the dot no border (Review 4)', () => {
    const { container } = render(<LakeLabel name="A" slug={null} />);
    expect(container.querySelector('circle')?.getAttribute('stroke')).toBeNull();
  });
});

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

describe('DepthLegend', () => {
  it('shows seven bands over their edges, the unit with the last figure', () => {
    const { container } = render(<DepthLegend />);
    expect(screen.getByRole('img', { name: /Depth bands from 0 to 70 feet/ })).toBeInTheDocument();
    expect(container.querySelectorAll('b')).toHaveLength(7);
    expect(screen.getByText('ft')).toBeInTheDocument();
    expect(container.textContent).toContain('Depth');
    // Data, never a verdict (D3).
    expect(container.textContent).not.toMatch(/safe|thick|good/i);
  });

  it('shows an open lake’s own bands at their real depths, colored by index, not position', () => {
    // Mascoma, contoured every 10 ft (BANDS.md): no band 1, a 30–50 band, the deepest open-ended.
    const mascoma = [
      { bandIndex: 0, minDepthFt: 0, maxDepthFt: 10 },
      { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 },
      { bandIndex: 3, minDepthFt: 20, maxDepthFt: 30 },
      { bandIndex: 4, minDepthFt: 30, maxDepthFt: 50 },
      { bandIndex: 5, minDepthFt: 50, maxDepthFt: 70 },
      { bandIndex: 6, minDepthFt: 70 },
    ];
    const { container } = render(<DepthLegend bands={mascoma} />);
    expect(
      screen.getByRole('img', {
        name: 'Depth bands: 0–10 ft, 10–20 ft, 20–30 ft, 30–50 ft, 50–70 ft, 70+ ft',
      }),
    ).toBeInTheDocument();
    const swatches = [...container.querySelectorAll('b')];
    expect(swatches.map((b) => b.dataset.band)).toEqual(['0', '2', '3', '4', '5', '6']);
    expect(swatches[1]?.className).toContain('bg-depth-2');
    expect(swatches.map((b) => b.title)).toEqual([
      '0–10 ft',
      '10–20 ft',
      '20–30 ft',
      '30–50 ft',
      '50–70 ft',
      '70+ ft',
    ]);
    // The figures are the real floors — 50, never the ramp's 45.
    expect(container.textContent).toContain('01020305070+ft');
    expect(container.textContent).not.toContain('45');
  });

  it('clamps an index past the ramp to the deepest swatch', () => {
    const { container } = render(<DepthLegend bands={[{ bandIndex: 9, minDepthFt: 120 }]} />);
    expect(container.querySelector('b')?.className).toContain('bg-depth-6');
    expect(screen.getByRole('img', { name: 'Depth bands: 120+ ft' })).toBeInTheDocument();
  });
});
