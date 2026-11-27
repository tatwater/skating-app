import { createFileRoute } from '@tanstack/react-router';
import { MachineryRoute } from '../components/admin/machinery/MachineryRoute';

/**
 * The console's Machinery (B01-8, D340): the pipelines at work, the corpus campaign first. A layout:
 * the mode's sidebar (its one read, shared by every page under it) and an outlet, each built
 * pipeline's page its own route under it. This file is only the route binding; the frame lives in
 * `components/admin/machinery/MachineryRoute`.
 */
export const Route = createFileRoute('/admin/machinery')({
  component: MachineryRoute,
});
