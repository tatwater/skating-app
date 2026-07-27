/**
 * The `/admin` gate (D37) — the tree the lake editor lives in (N2 / D61).
 *
 * This is a **UX** boundary, not a security one, and the distinction is the reason the test says what
 * it says: every Convex function under here hard-gates on `role` server-side, so a member who forces
 * the route gets refused by the data regardless. What this pins is that they never see operator
 * chrome while that happens — no flash of the sidebar, no half-rendered queue, no editor canvas for a
 * lake they can't edit. `convex/subAreas.test.ts` covers the half that actually protects the data.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
let pathname = '/admin/water/b1';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname } }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  Outlet: () => <div data-testid="admin-content">the editor</div>,
}));

const role = { isModerator: false, isAdmin: false, isLoading: false };
vi.mock('../../lib/useRole', () => ({ useRole: () => role }));
vi.mock('../Splash', () => ({ Splash: () => <div data-testid="splash" /> }));

const { AdminLayout } = await import('./AdminLayout');

beforeEach(() => {
  navigate.mockClear();
  pathname = '/admin/water/b1';
  role.isModerator = false;
  role.isAdmin = false;
  role.isLoading = false;
});

describe('the /admin gate', () => {
  it('bounces a member off the tree without rendering any operator chrome', () => {
    render(<AdminLayout />);
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
    expect(screen.queryByTestId('admin-content')).toBeNull();
    expect(screen.getByTestId('splash')).toBeTruthy();
  });

  it('holds on a splash while the role is still resolving, rather than guessing', () => {
    role.isLoading = true;
    render(<AdminLayout />);
    // Neither outcome yet: no redirect on an unknown role, and no chrome either.
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('admin-content')).toBeNull();
  });

  it('lets a moderator into the lake editor', () => {
    role.isModerator = true;
    render(<AdminLayout />);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-content')).toBeTruthy();
  });

  it('keeps a moderator out of the admin-only children (PII + constants)', () => {
    role.isModerator = true;
    pathname = '/admin/tuning';
    render(<AdminLayout />);
    expect(navigate).toHaveBeenCalledWith({ to: '/admin' });
    expect(screen.queryByTestId('admin-content')).toBeNull();
  });

  it('hides the admin-only links from a moderator’s sidebar', () => {
    role.isModerator = true;
    render(<AdminLayout />);
    expect(screen.getByText('Water bodies')).toBeTruthy();
    expect(screen.queryByText('Tuning')).toBeNull();
  });
});
