import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DepthLegend } from './DepthLegend';
import { LakeLabel } from './LakeLabel';
import { HazardMark, PutInMark } from './MapMarks';

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
});
