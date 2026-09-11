import type { Id } from '@skating/convex/dataModel';
import { buildSubAreaSpread } from '@skating/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('convex/react', () => ({ useQuery }));
// The router's `Link` needs a router; the assertion is about where the link points, so a plain
// anchor that renders the same destination is enough to prove the wiring.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    search,
    children,
    className,
  }: {
    params: { id: string };
    search: { sub: string };
    children: string;
    className?: string;
  }) => (
    <a href={`/water/${params.id}?sub=${search.sub}`} className={className}>
      {children}
    </a>
  ),
}));

const { SubAreaSpread } = await import('./SubAreaSpread');

const LAKE = 'lake1' as Id<'waterBodies'>;
const DAY = 86_400_000;
const D0 = Date.UTC(2027, 0, 10);
const days = (lowC: number, snowCm: number) =>
  [0, 1, 2, 3, 4, 5, 6].map((i) => ({
    dayMs: D0 + i * DAY,
    nightMinTempC: lowC,
    snowfallCm: i === 0 ? snowCm : 0,
  }));

describe('SubAreaSpread', () => {
  it('renders the lines with the named extremes as links to the bay', () => {
    useQuery.mockReturnValue(
      buildSubAreaSpread([
        { subAreaId: 'miss', name: 'Missisquoi Bay', days: days(-18, 0) },
        { subAreaId: 'burl', name: 'Burlington Bay', days: days(-11, 10) },
      ]),
    );
    render(<SubAreaSpread waterBodyId={LAKE} />);
    expect(screen.getByText('Across 2 bays over the last 7 days')).toBeInTheDocument();
    const coldest = screen.getAllByRole('link', { name: 'Missisquoi Bay' })[0];
    expect(coldest).toHaveAttribute('href', '/water/lake1?sub=miss');
    expect(screen.getAllByRole('link', { name: 'Burlington Bay' })[0]).toHaveAttribute(
      'href',
      '/water/lake1?sub=burl',
    );
    // The sentence reads as one line around the links.
    expect(screen.getByText(/coldest at/).textContent).toBe(
      'Lows 0°F to 12°F — coldest at Missisquoi Bay, mildest at Burlington Bay',
    );
  });

  it('collapses to the one-liner when the bays agree, and renders nothing before the season', () => {
    useQuery.mockReturnValue(
      buildSubAreaSpread([
        { subAreaId: 'a', name: 'A Bay', days: days(-10, 0) },
        { subAreaId: 'b', name: 'B Bay', days: days(-11, 0) },
      ]),
    );
    const { rerender } = render(<SubAreaSpread waterBodyId={LAKE} />);
    expect(screen.getByText(/^Similar across the lake/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    useQuery.mockReturnValue(null);
    rerender(<SubAreaSpread waterBodyId={LAKE} />);
    expect(screen.queryByText(/Across the lake/i)).not.toBeInTheDocument();
  });
});
