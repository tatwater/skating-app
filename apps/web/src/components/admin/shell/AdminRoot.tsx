import { useRouterState } from '@tanstack/react-router';
import { AdminLayout } from '../AdminLayout';
import { ConsoleLayout } from './ConsoleLayout';
import { usesOldShell } from './consoleNav';

/**
 * The `/admin` layout route's component: the console for the pages it has built, and — until each
 * one's mode lands — the old gate and sidebar for the old pages still standing. One predicate
 * (`usesOldShell`) decides this, `AuthGate`'s old-`AppShell` wrap and the surface attribute, so
 * an old page is never drawn half in one shell and half in the other.
 *
 * It lives here rather than in `routes/admin.tsx` because the route file is transformed by the
 * TanStack Start plugin, which strips exports outside the route contract.
 */
export function AdminRoot() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return usesOldShell(pathname) ? <AdminLayout /> : <ConsoleLayout />;
}
