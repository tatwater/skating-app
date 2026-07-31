import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useRole } from '../../lib/useRole';
import { Splash } from '../Splash';

/**
 * The operator surface's shell (D37) — a role-gated `/admin` tree inside the web app (not a second
 * app). It gates the whole tree at **moderator**, redirects a moderator off the **admin-only**
 * children (`/admin/support`, `/admin/tuning` — PII + constants), renders the sidebar (hiding links
 * the caller can't use), and hosts the child pages via `<Outlet/>`.
 *
 * The client gate is a **UX** boundary, not a security one: every underlying Convex function
 * hard-gates on `role` server-side, so a member who forces the route is refused by the data
 * regardless. What this buys is that they never see operator chrome while that happens.
 *
 * It lives here rather than in `routes/admin.tsx` because the route file is transformed by the
 * TanStack Start plugin, which strips exports that aren't part of the route contract — so a component
 * defined there can be *rendered* but not imported, including by a test. Thin route, real module.
 */
export function AdminLayout() {
  const { isModerator, isAdmin, isLoading } = useRole();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (isLoading) return;
    if (!isModerator) {
      void navigate({ to: '/' });
    } else if (!isAdmin && ADMIN_ONLY_PREFIXES.some((p) => pathname.startsWith(p))) {
      void navigate({ to: '/admin' });
    }
  }, [isLoading, isModerator, isAdmin, pathname, navigate]);

  // Hold on a splash while resolving the role or mid-redirect, so we never flash operator chrome.
  if (isLoading || !isModerator) return <Splash />;
  if (!isAdmin && ADMIN_ONLY_PREFIXES.some((p) => pathname.startsWith(p))) return <Splash />;

  const items = NAV.filter((item) => isAdmin || !item.adminOnly);

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav className="flex gap-1 overflow-x-auto border-border border-b pb-2 text-sm md:w-48 md:flex-col md:border-none md:pb-0">
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={item.exact ? { exact: true } : undefined}
            className={`${linkClass} whitespace-nowrap`}
            activeProps={{ className: `${activeClass} whitespace-nowrap` }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

/** Paths only an admin may reach — a moderator is bounced back to the dashboard. */
const ADMIN_ONLY_PREFIXES = ['/admin/support', '/admin/tuning'];

interface NavItem {
  to: string;
  label: string;
  adminOnly?: boolean;
  exact?: boolean;
}
const NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', exact: true },
  { to: '/admin/flags', label: 'Flags' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/water', label: 'Water bodies' },
  { to: '/admin/features', label: 'Body features' },
  { to: '/admin/recurrence', label: 'Hazard identity' },
  { to: '/admin/support', label: 'Support', adminOnly: true },
  { to: '/admin/tuning', label: 'Tuning', adminOnly: true },
];

const linkClass =
  'block rounded-md px-3 py-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground';
const activeClass = 'block rounded-md px-3 py-1.5 bg-surface-muted font-medium text-foreground';
