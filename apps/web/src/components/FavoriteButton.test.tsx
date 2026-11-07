import type { Id } from '@skating/convex/dataModel';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  toggle: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('convex/react', () => ({
  useQuery: mocks.useQuery,
  useMutation: () => mocks.toggle,
}));

vi.mock('../lib/analytics', () => ({
  useAnalytics: () => ({ capture: mocks.capture }),
}));

const { FavoriteButton } = await import('./FavoriteButton');

const LAKE = 'lake1' as Id<'waterBodies'>;
const BAY = 'bay1' as Id<'waterBodySubAreas'>;

beforeEach(() => {
  mocks.useQuery.mockReset();
  mocks.toggle.mockReset();
  mocks.capture.mockReset();
});

describe('FavoriteButton analytics (D235)', () => {
  it('records a favorite from the mutation’s post-state', async () => {
    mocks.useQuery.mockReturnValue(false);
    mocks.toggle.mockResolvedValue({ favorited: true });

    render(<FavoriteButton waterBodyId={LAKE} />);
    await userEvent.click(screen.getByRole('button', { name: /add to favorites/i }));

    expect(mocks.capture).toHaveBeenCalledWith('water_body_favorited', {
      target_type: 'water_body',
    });
  });

  it('records an unfavorite from the mutation’s post-state', async () => {
    mocks.useQuery.mockReturnValue(true);
    mocks.toggle.mockResolvedValue({ favorited: false });

    render(<FavoriteButton waterBodyId={LAKE} />);
    await userEvent.click(screen.getByRole('button', { name: /remove from favorites/i }));

    expect(mocks.capture).toHaveBeenCalledWith('water_body_unfavorited', {
      target_type: 'water_body',
    });
  });

  /**
   * The regression this replaced. The button is only disabled while `isFavorite` is `undefined`
   * (first load), so two taps before the reactive query catches up both see the same render-time
   * `isFav`. Naming the event from that value recorded two `water_body_favorited`s for a
   * favorite-then-unfavorite, inflating the one figure the event exists to measure. The server's
   * return value is never stale, so the pair comes out as one of each.
   */
  it('does not record two favorites when two taps race the query', async () => {
    mocks.useQuery.mockReturnValue(false); // stale across both clicks, as the real query would be
    mocks.toggle
      .mockResolvedValueOnce({ favorited: true })
      .mockResolvedValueOnce({ favorited: false });

    render(<FavoriteButton waterBodyId={LAKE} />);
    const button = screen.getByRole('button', { name: /add to favorites/i });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(mocks.capture.mock.calls.map(([name]) => name)).toEqual([
      'water_body_favorited',
      'water_body_unfavorited',
    ]);
  });

  it('marks a bay’s heart as a sub-area, not a water body', async () => {
    mocks.useQuery.mockReturnValue(false);
    mocks.toggle.mockResolvedValue({ favorited: true });

    render(<FavoriteButton waterBodyId={LAKE} subAreaId={BAY} />);
    await userEvent.click(screen.getByRole('button', { name: /add to favorites/i }));

    expect(mocks.capture).toHaveBeenCalledWith('water_body_favorited', {
      target_type: 'sub_area',
    });
  });

  /** A refused toggle is not a favorite. Nothing may be recorded for it. */
  it('records nothing when the mutation fails', async () => {
    mocks.useQuery.mockReturnValue(false);
    mocks.toggle.mockRejectedValue(new Error('Water body not found'));

    render(<FavoriteButton waterBodyId={LAKE} />);
    await userEvent.click(screen.getByRole('button', { name: /add to favorites/i }));

    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
