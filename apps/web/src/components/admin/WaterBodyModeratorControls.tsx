import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link } from '@tanstack/react-router';
import { useMutation } from 'convex/react';
import { cn } from '@/lib/utils';
import { useRole } from '../../lib/useRole';
import { Button, buttonVariants } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { ReasonDialog } from './ReasonDialog';

/**
 * In-context moderator affordances on a water-body detail (D37/D49).
 *
 * **The curated-boost field used to live here and is now a link to the lake editor.** A lone number
 * input was the whole of this card's editing surface, and it was the *worse* copy of a control the
 * editor already has: there, `setCuratedBoost` sits beside the resulting `displayScore` and
 * `minVisibleZoom`, so an operator can see what a boost of 0.3 actually does to the zoom a lake draws
 * at. Here it was a bare number with no feedback, on a panel a skater is also looking at.
 *
 * **Approve/reject stayed**, and the difference is worth stating: they are a decision about *this*
 * body made at the moment you are looking at it, they appear only on a pending user-drawn body (a
 * rare, transient state), and sending someone to another page to press Approve would be friction on
 * the one action that is genuinely time-sensitive here. Editing prominence is curation you sit down
 * to do; approving a body is something you do in passing.
 *
 * Renders nothing for non-moderators.
 */
export function WaterBodyModeratorControls({
  body,
}: {
  body: {
    _id: string;
    source: string;
    reviewStatus?: 'pending' | 'approved' | 'rejected';
  };
}) {
  const { canModerate } = useRole();
  const approve = useMutation(api.waterBodies.approve);
  const reject = useMutation(api.waterBodies.reject);

  if (!canModerate) return null;

  const waterBodyId = body._id as Id<'waterBodies'>;
  const isPendingUserBody = body.source === 'user' && body.reviewStatus === 'pending';

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Moderator tools
        </p>

        {/* A link rather than a `<Button onClick={navigate}>`: it is a navigation, so it should
            middle-click, open in a new tab, and show its destination on hover like one. */}
        <Link
          to="/admin/water/$id"
          params={{ id: body._id }}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start')}
        >
          Open in the lake editor
        </Link>
        <p className="text-foreground-muted text-xs">
          Prominence, depth, names, sub-areas, access points, posted rules and the moderation
          history — all of it, with the audit trail.
        </p>

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
