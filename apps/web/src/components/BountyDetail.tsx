import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatSkateTime, SKATE_QUALITY_LABELS } from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { expiryLabel } from './BountyList';
import { DetailSkeleton, UnavailableState } from './DrawerStates';
import { useIsLeaving } from './LeavingNotice';
import { ThumbControl } from './ThumbControl';
import { TrustAvatar } from './TrustDisplay';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  fulfilled: 'Fulfilled',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/**
 * `/bounty/$id` detail drawer (D47). Shows the requester (ringed by trust), the reward, and the candidate
 * reports that have auto-attached. The **requester** can cancel an open bounty, or mark a candidate report
 * **helpful** — which fulfills the bounty and pays its author (decisions 10–11), driven by the shared
 * thumbs control with the `bountyId` threaded through. Others just see the status + candidates.
 */
export function BountyDetail({ bountyId }: { bountyId: string }) {
  const detail = useQuery(api.bounties.getDetail, { bountyId: bountyId as Id<'bounties'> });
  const leaving = useIsLeaving();
  const cancel = useMutation(api.bounties.cancel);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (detail === undefined) return <DetailSkeleton />;
  if (detail === null) {
    return (
      <UnavailableState
        title="Bounty not available"
        message="This bounty may have been cancelled or removed."
      />
    );
  }

  const now = Date.now();
  const isOpen = detail.status === 'open';

  const onCancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await cancel({ bountyId: bountyId as Id<'bounties'> });
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : 'Could not cancel — check your connection and try again.',
      );
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Bounty{detail.waterBody ? ` · ${detail.waterBody.name}` : ''}</SheetTitle>
        <SheetDescription>
          {STATUS_LABEL[detail.status] ?? detail.status}
          {isOpen ? ` · ${expiryLabel(detail.expiresAt, now)}` : ''}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4 pb-4">
        <div className="flex items-center gap-2">
          <TrustAvatar
            displayName={detail.requester.displayName}
            trustClass={detail.requester.trustClass}
            size={28}
          />
          <div className="flex-1 text-sm">
            {/* No link for a requester there's nothing to link to. Two distinct cases: an
                *unresolvable* one has no username at all, and a **deleted** one now has a synthetic
                sentinel handle (N3) — which passes an emptiness check while still routing nowhere,
                so `deleted` has to be checked explicitly. */}
            {detail.requester.username && !detail.requester.deleted ? (
              <Link
                to="/u/$username"
                params={{ username: detail.requester.username }}
                className="text-foreground underline-offset-4 hover:underline"
              >
                {detail.requester.displayName}
              </Link>
            ) : (
              <span className="text-foreground">{detail.requester.displayName}</span>
            )}
            <span className="text-foreground-muted"> wants fresh eyes here</span>
          </div>
          <Badge variant="secondary">{detail.rewardPoints} pts</Badge>
        </div>

        {detail.waterBody ? (
          <Link
            to="/water/$id"
            params={{ id: detail.waterBody._id }}
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            View the lake
          </Link>
        ) : null}

        <Separator />

        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
            Candidate reports
          </h3>
          {detail.fulfillingReports.length === 0 ? (
            <p className="text-foreground-muted text-sm">
              No reports yet. Recent skaters have been notified.
            </p>
          ) : (
            detail.fulfillingReports.map((report) => (
              <div
                key={report._id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-2.5"
              >
                <div className="flex items-center gap-2 text-sm">
                  <TrustAvatar
                    displayName={report.authorName}
                    trustClass={report.authorTrustClass}
                    size={20}
                  />
                  <Link
                    to="/report/$id"
                    params={{ id: report._id }}
                    className="min-w-0 flex-1 truncate text-foreground underline-offset-4 hover:underline"
                  >
                    {report.authorName} · {formatSkateTime(report.skateEndTime)}
                  </Link>
                  {report.skateQuality ? (
                    <Badge variant="secondary">{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
                  ) : null}
                </div>
                {/* Requester-only: a helpful thumb here fulfills the bounty + pays the author.
                    Closed while the requester's own deletion is pending (D62 amendment) — the thumb
                    is a rating, and a rating is a contribution. */}
                {detail.isRequester && isOpen && !report.isOwn && !leaving ? (
                  <ThumbControl
                    targetType="report"
                    targetId={report._id}
                    canRate
                    bountyId={detail._id}
                  />
                ) : null}
              </div>
            ))
          )}
        </div>

        {detail.isRequester && isOpen ? (
          <>
            <Separator />
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                onClick={onCancel}
                disabled={cancelling}
                className="self-start"
              >
                {cancelling ? 'Cancelling…' : 'Cancel bounty'}
              </Button>
              {error ? (
                <p role="alert" className="text-destructive text-xs">
                  {error}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
