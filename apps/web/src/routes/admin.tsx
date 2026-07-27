import { createFileRoute } from '@tanstack/react-router';
import { AdminLayout } from '../components/admin/AdminLayout';

/**
 * The operator surface (D37) — a role-gated `/admin` tree inside the web app (not a second app).
 * The gate, the sidebar and the `<Outlet/>` live in `components/admin/AdminLayout`; this file is
 * only the route binding, so the layout stays importable (route files are transformed by the
 * TanStack Start plugin, which strips exports outside the route contract).
 */
export const Route = createFileRoute('/admin')({ component: AdminLayout });
