/**
 * After Sign out, the browser's Back lands on console paths again — and the gate draws none of them:
 * signed out, every `/admin` path holds on the splash and goes to sign in, its page never drawn.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pathname: '/admin', push: vi.fn() }));

vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
}));
vi.mock('convex/react', () => ({ useQuery: () => undefined }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: mocks.push } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: mocks.pathname }, matches: [] }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSheetOwnerBinding: vi.fn() }));
vi.mock('@/components/skater/OfflineBoundary', () => ({
  FirstLoadSplash: () => <p>splash</p>,
  FirstLoadHold: ({ children }: { children: unknown }) => children,
}));

const { AuthGate } = await import('@/components/AuthGate');

beforeEach(() => {
  mocks.push = vi.fn();
});

describe('signed out, Back into the console', () => {
  it.each(['/admin', '/admin/corpus', '/admin/body/b1', '/admin/people/p1', '/admin/flags'])(
    'draws nothing of %s and sends it to sign in',
    (path) => {
      mocks.pathname = path;
      render(<AuthGate>console page</AuthGate>);
      expect(screen.queryByText('console page')).toBeNull();
      expect(screen.getByText('splash')).toBeInTheDocument();
      expect(mocks.push).toHaveBeenCalledWith('/sign-in');
    },
  );
});
