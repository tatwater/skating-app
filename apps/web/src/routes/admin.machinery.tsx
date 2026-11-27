import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * The console's Machinery (B01-8, D340): the pipelines at work, the corpus campaign first. A layout:
 * the mode's sidebar beside an outlet, each built pipeline's page its own route under it. This file
 * is only the route binding; the page lives in `components/admin/machinery/`.
 *
 * PLACEHOLDER (B01-8a T0): a bare outlet until the frame (`MachineryRoute`) lands.
 */
export const Route = createFileRoute('/admin/machinery')({
  component: () => <Outlet />,
});
