import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { useState } from 'react';
import { useRole } from '../../lib/useRole';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ReasonDialog } from './ReasonDialog';

/**
 * In-context moderator affordances on a water-body detail (D37/D49) — set the display `curatedBoost`
 * from the body itself, and approve/reject a pending user-drawn body without opening the queue. Same
 * server-gated mutations as `/admin/water`. Renders nothing for non-moderators.
 */
export function WaterBodyModeratorControls({
  body,
}: {
  body: {
    _id: string;
    source: string;
    reviewStatus?: 'pending' | 'approved' | 'rejected';
    curatedBoost?: number;
  };
}) {
  const { canModerate } = useRole();
  const setCuratedBoost = useMutation(api.waterBodies.setCuratedBoost);
  const approve = useMutation(api.waterBodies.approve);
  const reject = useMutation(api.waterBodies.reject);
  const [boost, setBoost] = useState(String(body.curatedBoost ?? 0));

  if (!canModerate) return null;

  const waterBodyId = body._id as Id<'waterBodies'>;
  const isPendingUserBody = body.source === 'user' && body.reviewStatus === 'pending';

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Moderator tools
        </p>

        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="curated-boost">Curated boost</Label>
            <Input
              id="curated-boost"
              type="number"
              step="0.1"
              value={boost}
              onChange={(e) => setBoost(e.target.value)}
              className="w-28"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const value = Number(boost);
              if (Number.isFinite(value))
                void setCuratedBoost({ waterBodyId, curatedBoost: value });
            }}
          >
            Set prominence
          </Button>
        </div>

        {isPendingUserBody ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => approve({ waterBodyId })}>
              Approve body
            </Button>
            <ReasonDialog
              trigger={
                <Button variant="outline" size="sm">
                  Reject body
                </Button>
              }
              title="Reject this water body"
              description="Removes it from the map (not a hard delete)."
              confirmLabel="Reject"
              requireReason={false}
              reasonPlaceholder="Optional note for the audit log"
              onConfirm={(reason) => reject({ waterBodyId, ...(reason ? { reason } : {}) })}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
