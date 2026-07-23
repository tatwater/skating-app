import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * Known seasonal body features (D53) — the persistent, non-decaying attributes (springs, ridges,
 * bridge-narrows) a moderator has graduated from recurring hazards. This page lists the active ones and
 * demotes them; **promotion happens in-context** from a hazard pin on the map (a feature needs a source
 * hazard to graduate).
 */
export const Route = createFileRoute('/admin/features')({ component: AdminFeatures });

function AdminFeatures() {
  const features = useQuery(api.bodyFeatures.listRecent, {});
  const demote = useMutation(api.bodyFeatures.demote);

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title="Body features"
        subtitle="Persistent seasonal attributes. Promote a recurring hazard from its pin on the map."
      />
      {features === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : features.length === 0 ? (
        <AdminEmpty>No known body features yet.</AdminEmpty>
      ) : (
        features.map((f) => (
          <Card key={f.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{f.type}</Badge>
                  <span className="text-foreground text-sm">{f.waterBodyName}</span>
                </div>
                {f.note ? <p className="text-foreground-muted text-xs">{f.note}</p> : null}
              </div>
              <ReasonDialog
                trigger={
                  <Button variant="outline" size="sm">
                    Demote
                  </Button>
                }
                title="Demote this body feature"
                description="Reversible — flips it inactive and un-supersedes the source hazard if any."
                confirmLabel="Demote"
                onConfirm={(reason) =>
                  demote({ bodyFeatureId: f.id as Id<'bodyFeatures'>, reason })
                }
              />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
