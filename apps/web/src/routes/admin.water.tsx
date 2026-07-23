import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * Water-body review (D37) + dedup merge (D36). Two queues: user-drawn bodies awaiting approve/reject,
 * and suspected duplicates a moderator merges into a survivor (re-pointing children, soft-tombstoning
 * the loser). The dedup queue stays near-empty until Phase 8 wires match-on-create.
 */
export const Route = createFileRoute('/admin/water')({ component: AdminWater });

function AdminWater() {
  const pending = useQuery(api.waterBodies.listPendingReview, {});
  const dedup = useQuery(api.waterBodies.listDedupCandidates, {});
  const approve = useMutation(api.waterBodies.approve);
  const reject = useMutation(api.waterBodies.reject);
  const merge = useMutation(api.waterBodies.merge);

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Water bodies"
        subtitle="Review user-drawn bodies + merge duplicates."
      />

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Pending review
        </h2>
        {pending === undefined ? (
          <AdminEmpty>Loading…</AdminEmpty>
        ) : pending.length === 0 ? (
          <AdminEmpty>No user-drawn bodies awaiting review.</AdminEmpty>
        ) : (
          pending.map((body) => (
            <Card key={body._id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-foreground text-sm">{body.name}</p>
                  <p className="text-foreground-muted text-xs">{body.type} · user-drawn</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => approve({ waterBodyId: body._id })}
                  >
                    Approve
                  </Button>
                  <ReasonDialog
                    trigger={
                      <Button variant="outline" size="sm">
                        Reject
                      </Button>
                    }
                    title={`Reject “${body.name}”`}
                    description="Removes it from the map (reversible-in-spirit; not a hard delete)."
                    confirmLabel="Reject"
                    requireReason={false}
                    reasonPlaceholder="Optional note for the audit log"
                    onConfirm={(reason) =>
                      reject({ waterBodyId: body._id, ...(reason ? { reason } : {}) })
                    }
                  />
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Suspected duplicates
        </h2>
        {dedup === undefined ? (
          <AdminEmpty>Loading…</AdminEmpty>
        ) : dedup.length === 0 ? (
          <AdminEmpty>No suspected duplicates. (Populated once Phase 8 lands.)</AdminEmpty>
        ) : (
          dedup.map(({ body, candidates }) => (
            <Card key={body._id}>
              <CardContent className="flex flex-col gap-2">
                <p className="text-foreground text-sm">{body.name}</p>
                <p className="text-foreground-muted text-xs">Merge into the canonical body:</p>
                <div className="flex flex-wrap gap-2">
                  {candidates.length === 0 ? (
                    <span className="text-foreground-muted text-xs">No candidates recorded.</span>
                  ) : (
                    candidates.map((c) => (
                      <ReasonDialog
                        key={c.id}
                        trigger={
                          <Button variant="outline" size="sm">
                            Merge → {c.name}
                          </Button>
                        }
                        title={`Merge “${body.name}” into “${c.name}”`}
                        description="Re-points reports/hazards/bounties to the survivor and tombstones this one."
                        confirmLabel="Merge"
                        confirmVariant="default"
                        requireReason={false}
                        onConfirm={(reason) =>
                          merge({
                            survivorId: c.id as Id<'waterBodies'>,
                            loserId: body._id,
                            ...(reason ? { reason } : {}),
                          })
                        }
                      />
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
