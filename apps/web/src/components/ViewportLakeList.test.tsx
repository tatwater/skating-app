import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { ViewportLake } from '../lib/viewportLakes';
import { ViewportLakeListView } from './ViewportLakeList';

/**
 * The sidebar's resting state. It is on screen more than any other panel in the app — every time
 * the map is open and nothing is selected — and its three states are easy to confuse for each
 * other: "nothing loaded yet" and "nothing here" look identical if either is rendered as a blank
 * column, and on a regional view "nothing here" is usually wrong (the small stuff isn't drawn until
 * you zoom, D49/N1). So each state is pinned to the copy that distinguishes it.
 */
function renderWithRouter(ui: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  });
  const waterRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/water/$id',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, waterRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: the test router isn't the app's registered router.
  return render(<RouterProvider router={router as any} />);
}

function lake(over: Partial<ViewportLake> & { _id: string }): ViewportLake {
  return { name: '', type: 'lakePond', ...over };
}

const NONE: ReadonlySet<string> = new Set();

describe('ViewportLakeListView', () => {
  it('links each lake to its own page', async () => {
    renderWithRouter(
      <ViewportLakeListView
        lakes={[lake({ _id: 'b1', name: 'Lake Willoughby', surfaceAreaSqM: 6_000_000 })]}
        favoriteIds={NONE}
      />,
    );
    const link = await screen.findByRole('link', { name: /Lake Willoughby/ });
    expect(link).toHaveAttribute('href', '/water/b1');
  });

  it('describes a lake by class, size and state', async () => {
    renderWithRouter(
      <ViewportLakeListView
        lakes={[lake({ _id: 'b1', name: 'Willoughby', surfaceAreaSqM: 6_000_000, states: ['VT'] })]}
        favoriteIds={NONE}
      />,
    );
    expect(await screen.findByText(/Lake or pond · .* acres · VT/)).toBeInTheDocument();
  });

  it('leaves unnamed water off the list entirely', async () => {
    renderWithRouter(
      <ViewportLakeListView
        lakes={[lake({ _id: 'u1' }), lake({ _id: 'b1', name: 'Thompsons Lake' })]}
        favoriteIds={NONE}
      />,
    );
    expect(await screen.findByText('Thompsons Lake')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByText(/Unnamed/)).not.toBeInTheDocument();
  });

  it('says the water is there when the viewport holds only unnamed ponds', async () => {
    // Not "no water in view" — the map is full of shapes, and contradicting it reads as a bug.
    renderWithRouter(<ViewportLakeListView lakes={[lake({ _id: 'u1' })]} favoriteIds={NONE} />);
    expect(await screen.findByText(/No named water in view/)).toBeInTheDocument();
    expect(screen.queryByText(/zoom in/)).not.toBeInTheDocument();
  });

  it('marks a favorite and floats it to the top', async () => {
    renderWithRouter(
      <ViewportLakeListView
        lakes={[
          lake({ _id: 'big', name: 'Champlain', surfaceAreaSqM: 1_000_000_000 }),
          lake({ _id: 'mine', name: 'Mill Pond', surfaceAreaSqM: 40_000 }),
        ]}
        favoriteIds={new Set(['mine'])}
      />,
    );
    const links = await screen.findAllByRole('link');
    expect(links[0]).toHaveTextContent('Mill Pond');
    expect(screen.getByLabelText('Favorite')).toBeInTheDocument();
  });

  it('waits rather than claiming the region is empty before the map has answered', async () => {
    renderWithRouter(<ViewportLakeListView lakes={null} favoriteIds={NONE} />);
    expect(await screen.findByText(/Pan the map/)).toBeInTheDocument();
    expect(screen.queryByText(/No water in view/)).not.toBeInTheDocument();
  });

  it('tells an empty viewport to zoom in, since small ponds are not drawn yet', async () => {
    renderWithRouter(<ViewportLakeListView lakes={[]} favoriteIds={NONE} />);
    expect(await screen.findByText(/zoom in/)).toBeInTheDocument();
  });

  it('says how many rows the cap left off', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      lake({ _id: `b${i}`, name: `Lake ${i}`, surfaceAreaSqM: 1000 - i }),
    );
    renderWithRouter(<ViewportLakeListView lakes={many} favoriteIds={NONE} />);
    expect(await screen.findByText(/\+ 10 more in view/)).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(50);
  });
});
