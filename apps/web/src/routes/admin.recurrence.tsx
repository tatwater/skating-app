import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { hazardTypeLabel } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * Hazard identity, from the operator's side (N5c).
 *
 * **Today this page is the auto-merge audit, and that is the whole reason auto-merge could ship.** A
 * mechanism that folds one safety pin into another without a human, and leaves nowhere to look at what
 * it did, is a mechanism nobody can check. The bar it merges at (`AUTOMERGE_MIN_FOOTPRINT_IOU`) is a
 * guess until somebody watches it work — so every merge writes a row, this page lists them newest
 * first, and Unmerge is one click. A rising unmerge rate means the bar is too low, and the chart on
 * `/admin/tuning` is where that shows up as a number.
 *
 * The cross-lake **recurrence queue** lands here too, in the second half of the phase. It is named for
 * where it is going rather than for what it holds today, because moving a page an operator has learned
 * is a worse cost than a page that grows into its name.
 */
export const Route = createFileRoute('/admin/recurrence')({ component: AdminRecurrence });

function relativeWhen(at: number): string {
  const hours = (Date.now() - at) / 3_600_000;
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${Math.round(hours)} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function AdminRecurrence() {
  const merges = useQuery(api.hazards.listRecentMerges, {});
  const unmerge = useMutation(api.hazards.unmerge);

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title="Hazard identity"
        subtitle="Duplicate pins the app has folded into one. A merge never shrinks the warned area and never pools clearance votes — but it can still be wrong, so it is always reversible."
      />
      {merges === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : merges.length === 0 ? (
        <AdminEmpty>
          Nothing has been merged yet. Duplicates only collapse when their footprints genuinely
          overlap and share at least half their combined area.
        </AdminEmpty>
      ) : (
        merges.map((m) => (
          <Card key={m.actionId}>
            <CardContent className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={m.automatic ? 'secondary' : 'outline'}>
                    {m.automatic ? 'Automatic' : 'By a moderator'}
                  </Badge>
                  {m.action === 'unmerge_hazards' ? <Badge variant="outline">Undone</Badge> : null}
                  {m.type ? (
                    <span className="text-foreground text-sm">{hazardTypeLabel(m.type)}</span>
                  ) : null}
                  {m.waterBodyId ? (
                    <Link
                      to="/admin/water/$id"
                      params={{ id: m.waterBodyId }}
                      className="text-sm underline underline-offset-2"
                    >
                      {m.waterBodyName ?? 'this lake'}
                    </Link>
                  ) : null}
                </div>
                <p className="text-foreground-muted text-xs">
                  {relativeWhen(m.at)}
                  {m.survivorId ? ' · folded into the earlier sighting' : ''}
                </p>
              </div>
              {/* Only what is *currently* merged can be pulled apart — an already-undone row is
                  history, and offering the button on it would be offering a no-op. */}
              {m.stillMerged ? (
                <ReasonDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      Unmerge
                    </Button>
                  }
                  title="Separate these pins"
                  description="Both pins return to the map intact, with their own footprints and their own confirm loops. They will not be merged again automatically."
                  confirmLabel="Unmerge"
                  onConfirm={(reason) =>
                    unmerge({ hazardId: m.loserId as Id<'hazards'>, reason }).then(() => undefined)
                  }
                />
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
