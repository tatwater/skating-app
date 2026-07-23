import { createFileRoute } from '@tanstack/react-router';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';

/**
 * Tuning control-room (D37/D49) — **admin-only**. A read-only view of every tunable constant paired
 * with the chart that tells you whether it's set right. The constants + companion charts land with the
 * analytics commit (PR 7b); this is the gated route stub so the nav + role split exist now.
 */
export const Route = createFileRoute('/admin/tuning')({ component: AdminTuning });

function AdminTuning() {
  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title="Tuning"
        subtitle="Read-only control-room: every constant + the chart that tunes it."
      />
      <AdminEmpty>The constants and companion charts arrive with the analytics surface.</AdminEmpty>
    </div>
  );
}
