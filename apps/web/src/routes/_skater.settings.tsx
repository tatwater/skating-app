import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * `/settings` (B03 §1.5): the parent of the eight sections, so the bare path stays a route that old
 * links (`/settings`) and typed links can name. It draws nothing of its own; `/settings` itself
 * lands on Account through the index route.
 */
export const Route = createFileRoute('/_skater/settings')({ component: SettingsLayout });

function SettingsLayout() {
  return <Outlet />;
}
