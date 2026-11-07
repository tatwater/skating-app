import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SkaterShell } from '../components/skater/SkaterShell';
import { skaterRootSearchSchema } from '../lib/skaterSearch';

/**
 * The pathless skater layout (B03 §1.0, D242): validates the root search params (`?post=`,
 * `?postBody=`) so the report sheet can open over any skater page and over nothing else, and
 * mounts the skater shell. Canonical content — agents C, E and G land identical copies and the
 * integrations converge on one.
 */
export const Route = createFileRoute('/_skater')({
  validateSearch: skaterRootSearchSchema,
  component: SkaterLayout,
});

function SkaterLayout() {
  return (
    <SkaterShell>
      <Outlet />
    </SkaterShell>
  );
}
