import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { isNotFound } from './AuthGate';

/**
 * `isNotFound` against the real router, in the app's shape: a pathless skater layout, the old-shell
 * `/admin` tree and `/u/$username`. The 404 renders at the root — outside every layout — and the
 * matches say so; if a router upgrade drops the `_notFound` mark, this is where it shows.
 */
function routerAt(path: string) {
  const root = createRootRoute({
    component: () => <Outlet />,
    notFoundComponent: () => <p>not found</p>,
  });
  const page = (text: string) => () => <p>{text}</p>;
  const skater = createRoute({
    getParentRoute: () => root,
    id: '_skater',
    component: () => (
      <div data-testid="skater-layout">
        <Outlet />
      </div>
    ),
  });
  const admin = createRoute({
    getParentRoute: () => root,
    path: 'admin',
    component: () => (
      <div data-testid="admin-layout">
        <Outlet />
      </div>
    ),
  });
  const tree = root.addChildren([
    skater.addChildren([
      createRoute({ getParentRoute: () => skater, path: '/', component: page('explore') }),
      createRoute({ getParentRoute: () => skater, path: 'water/$id', component: page('lake') }),
    ]),
    admin.addChildren([
      createRoute({ getParentRoute: () => admin, path: '/', component: page('admin') }),
    ]),
    createRoute({ getParentRoute: () => root, path: 'u/$username', component: page('profile') }),
  ]);
  return createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

describe('isNotFound, against the real router', () => {
  it.each(['/lakes', '/water/a/b', '/admin/nope', '/u/a/b'])(
    '%s is a 404, rendered at the root outside every layout',
    async (path) => {
      const router = routerAt(path);
      render(<RouterProvider router={router as never} />);
      await screen.findByText('not found');
      expect(isNotFound(router.state)).toBe(true);
      expect(screen.queryByTestId('skater-layout')).toBeNull();
      expect(screen.queryByTestId('admin-layout')).toBeNull();
    },
  );

  it.each([
    ['/', 'explore'],
    ['/water/a', 'lake'],
    ['/admin', 'admin'],
    ['/u/a', 'profile'],
  ])('%s is not', async (path, text) => {
    const router = routerAt(path);
    render(<RouterProvider router={router as never} />);
    await screen.findByText(text);
    expect(isNotFound(router.state)).toBe(false);
  });
});
