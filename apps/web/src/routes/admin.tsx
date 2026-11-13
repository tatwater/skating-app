import { createFileRoute } from '@tanstack/react-router';
import { AdminRoot } from '../components/admin/shell/AdminRoot';

/**
 * The operator surface (D37) — a role-gated `/admin` tree inside the web app (not a second app),
 * on its own layout route, never under `_skater`. While B01's console replaces the old pages one
 * mode at a time, this binds both shells: the console for the pages it has built, the old gate and
 * sidebar for the rest (`components/admin/shell/AdminRoot`). This file is only the route binding,
 * so the layout stays importable (route files are transformed by the TanStack Start plugin, which
 * strips exports outside the route contract).
 */
export const Route = createFileRoute('/admin')({ component: AdminRoot });
