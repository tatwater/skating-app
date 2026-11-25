import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { isNotFound } from '../components/AuthGate';
import { usesOldShell } from '../components/admin/shell/consoleNav';
import { NotFoundRoute } from '../components/skater/SkaterShell';
import { routeTree } from '../routeTree.gen';

// The `-` prefix keeps this file out of the generated route tree (`routeFileIgnorePrefix`).

/**
 * **The retired redirects are gone, not blank** (B01-6a). `/admin/flags` and `/admin/support` went
 * into the Inbox, `/admin/users` and `/admin/users/$id` into People, and their redirects were
 * deleted with nothing left linking to them. Against the app's real route tree: each carries the
 * root's 404 mark, so the root's `NotFoundRoute` draws it outside every layout (the router's half,
 * pinned in `AuthGate.notFound.test.tsx`) and `AuthGate` leaves it bare (`isNotFound`) — never the
 * old shell, never an empty `/admin` layout. `/admin/water/requests` stays a redirect: without it
 * the old editor's `$id` would match `requests`.
 */
async function matchesAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  // Match only: a redirect throws from `beforeLoad`, which `load` would follow.
  const matches = router.matchRoutes(router.state.location);
  return { router, matches };
}

describe('the retired redirects', () => {
  it.each(['/admin/flags', '/admin/support', '/admin/users', '/admin/users/k17abc'])(
    '%s is the 404, drawn by the root, not the old shell',
    async (path) => {
      const { router, matches } = await matchesAt(path);
      expect(isNotFound({ matches })).toBe(true);
      // The root holds the mark, and no page under the `/admin` layout matched.
      expect(matches.map((m) => [m.routeId, m._notFound === true])).toEqual([
        ['__root__', true],
        ['/admin', false],
      ]);
      expect(router.routeTree.options.notFoundComponent).toBe(NotFoundRoute);
      expect(usesOldShell(path)).toBe(false);
    },
  );

  it.each([
    ['/admin/people', '/admin/people'],
    ['/admin/people/k17abc', '/admin/people/$id'],
    ['/admin/water/requests', '/admin/water/requests'],
    ['/admin/water/standing', '/admin/water/standing'],
  ])('still matches %s', async (path, routeId) => {
    const { matches } = await matchesAt(path);
    expect(isNotFound({ matches })).toBe(false);
    expect(matches.at(-1)?.routeId).toBe(routeId);
  });
});
