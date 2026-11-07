import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow, faPlus } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { isLeaving, SKATE_QUALITY_LABELS } from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useAction, useMutation, useQuery } from 'convex/react';
import { useMemo, useState } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { cn } from '@/lib/utils';

import { expiryLabel } from '../../BountyList';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../kit/alert-dialog';
import { Button } from '../../kit/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../kit/tooltip';
import { panelMapSpec } from '../map/mapSpec';
import { useMapSpec } from '../map/useMapSpec';
import { INK_PRIMARY } from '../styles';
import { type BountyPanelData, BountyPanelView, type BountyWanter } from './BountyPanelView';
import { InsetCard, PanelLoading, PanelUnavailable } from './InsetCard';
import { panelTriggerKey, useClosePanel, usePanelViewed } from './panelNavigation';
import { whenLabel } from './panelTime';
import { RatingsRow, writeError } from './RatingsRow';
import { PANEL_LOADING_SPEC } from './ReportPanel';

const STATUS: Record<string, string> = {
  open: 'Open',
  fulfilled: 'Fulfilled',
  expired: 'Expired',
  canceled: 'Canceled',
};

/** An open bounty, as `bounties.listForBody` lists it. */
interface OpenBountyRow {
  subAreaName?: string;
  requester: { displayName: string; username: string; profileImageUrl?: string };
}

/**
 * Everyone who wants a report on the same target as this bounty: the open asks on the same bay, or
 * the lake-wide ones for a lake-wide ask. `listForBody` with a bay also returns the lake-wide asks
 * (they're answerable from the bay, D175), which are a different target, so they're dropped here.
 */
export function wantersFor(
  rows: readonly OpenBountyRow[] | undefined,
  subAreaName: string | null,
  requester: BountyWanter,
): BountyWanter[] {
  if (rows === undefined) return [requester];
  const same = rows.filter((r) => (r.subAreaName ?? null) === subAreaName);
  const wanters = same.map((r) => ({
    displayName: r.requester.displayName,
    ...(r.requester.profileImageUrl !== undefined
      ? { profileImageUrl: r.requester.profileImageUrl }
      : {}),
  }));
  // A closed bounty is no longer in the open list; its own requester still asked.
  return wanters.length > 0 ? wanters : [requester];
}

/**
 * `/bounty/$id` (boards 2.6/2.7): the bounty as an inset card over its lake. Reads the bounty and the
 * other open asks on the same water; offers "Add a report" (the sheet over this card) and "I want
 * this too" (an ask of your own); the requester can thumb a candidate helpful — which fulfills it —
 * or cancel, which asks first and is red.
 */
export function BountyPanel({ bountyId }: { bountyId: string }) {
  const bid = bountyId as Id<'bounties'>;
  const now = useMemo(() => Date.now(), []);
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const detail = useQuery(api.bounties.getDetail, { bountyId: bid });
  const me = useQuery(api.profiles.current, {});
  const bodyId = detail?.waterBody?._id;
  const subAreaId = detail?.subArea?._id;
  const open = useQuery(
    api.bounties.listForBody,
    bodyId !== undefined
      ? { waterBodyId: bodyId, ...(subAreaId !== undefined ? { subAreaId } : {}) }
      : 'skip',
  );
  const create = useAction(api.bounties.create);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const spec = useMemo(
    () => (bodyId === undefined ? PANEL_LOADING_SPEC : panelMapSpec(bodyId)),
    [bodyId],
  );
  useMapSpec(spec);
  usePanelViewed('bounty_viewed', bountyId);
  const lake = useMemo(
    () =>
      bodyId === undefined ? null : { bodyId, ...(subAreaId !== undefined ? { subAreaId } : {}) },
    [bodyId, subAreaId],
  );
  const close = useClosePanel(lake);

  const common = {
    onClose: close,
    returnKey: panelTriggerKey('bounty', bountyId),
    label: 'Bounty',
  };

  if (detail === undefined) {
    return (
      <InsetCard {...common} backTo={null}>
        <PanelLoading />
      </InsetCard>
    );
  }
  if (detail === null) {
    return (
      <InsetCard {...common} backTo="Explore">
        <PanelUnavailable title="Bounty not available">
          This bounty may have been canceled or removed.
        </PanelUnavailable>
      </InsetCard>
    );
  }

  const isOpen = detail.status === 'open';
  const leaving = isLeaving(me);
  const subAreaName = detail.subArea?.name ?? null;
  const target = subAreaName ?? detail.waterBody?.name ?? 'Bounty';
  const requester: BountyWanter = {
    displayName: detail.requester.displayName,
    ...(detail.requester.profileImageUrl !== undefined
      ? { profileImageUrl: detail.requester.profileImageUrl }
      : {}),
  };
  const wanters = wantersFor(open as OpenBountyRow[] | undefined, subAreaName, requester);
  const alreadyWants =
    detail.isRequester ||
    (me != null &&
      ((open as OpenBountyRow[] | undefined) ?? []).some(
        (r) => (r.subAreaName ?? null) === subAreaName && r.requester.username === me.username,
      ));

  const data: BountyPanelData = {
    title: target,
    status: [
      STATUS[detail.status] ?? detail.status,
      isOpen ? expiryLabel(detail.expiresAt, now) : null,
      isOpen && subAreaName !== null ? 'only a report from this bay fulfills it' : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
    open: isOpen,
    mine: detail.isRequester,
    wanters,
    scope:
      subAreaName !== null
        ? `${subAreaName}, in ${detail.waterBody?.name ?? 'this lake'}`
        : `Any part of ${detail.waterBody?.name ?? 'this lake'}`,
    candidates: detail.fulfillingReports.map((r) => ({
      reportId: r._id,
      authorName: r.authorName,
      when: whenLabel(r.skateEndTime, now).replace(' · ', ' '),
      qualityLabel: r.skateQuality ? SKATE_QUALITY_LABELS[r.skateQuality] : null,
      isOwn: r.isOwn,
    })),
  };

  const ask = async () => {
    if (bodyId === undefined) return;
    setAsking(true);
    setAskError(null);
    try {
      await create({ waterBodyId: bodyId, ...(subAreaId !== undefined ? { subAreaId } : {}) });
      analytics.capture('bounty_posted', { scoped_to_sub_area: subAreaId !== undefined });
    } catch (err) {
      setAskError(writeError(err, 'Not sent. Check your connection and try again.'));
    } finally {
      setAsking(false);
    }
  };

  let foot: React.ReactNode;
  if (isOpen && detail.isRequester && !leaving) {
    foot = <CancelBounty bountyId={bountyId} />;
  } else if (isOpen && me && !leaving && bodyId !== undefined) {
    foot = (
      <>
        <Button
          variant="primary"
          size="sm"
          data-attr="bounty-add-report"
          className={INK_PRIMARY}
          onClick={() =>
            void navigate({
              to: '/bounty/$id',
              params: { id: bountyId },
              search: (prev) => ({ ...prev, post: 'new', postBody: bodyId }),
            })
          }
        >
          <FontAwesomeIcon icon={faPlus} aria-hidden="true" className="h-[0.8125rem]" />
          Add a report
        </Button>
        {!alreadyWants && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  data-attr="bounty-want-too"
                  loading={asking}
                  onClick={() => void ask()}
                />
              }
            >
              <FontAwesomeIcon
                icon={faBullseyeArrow}
                aria-hidden="true"
                className="h-[0.8125rem]"
              />
              I want this too
            </TooltipTrigger>
            <TooltipContent side="top">
              Adds you to the people who want a report here
            </TooltipContent>
          </Tooltip>
        )}
        {askError !== null && (
          <span role="alert" className="min-w-0 truncate text-assist text-bad">
            {askError}
          </span>
        )}
      </>
    );
  }

  return (
    <InsetCard {...common} backTo={target} foot={foot}>
      <BountyPanelView
        data={data}
        rateCandidate={(c) =>
          detail.isRequester && isOpen && !c.isOwn && !leaving ? (
            // The requester's helpful thumb is the bounty's end: it fulfills it (D47).
            <RatingsRow
              targetType="report"
              targetId={c.reportId}
              canRate
              bountyId={bountyId}
              compact
            />
          ) : (
            <RatingsRow
              targetType="report"
              targetId={c.reportId}
              canRate={!!me && !c.isOwn && !leaving}
              compact
              withUnhelpful={false}
            />
          )
        }
      />
    </InsetCard>
  );
}

/** Cancel is the requester's, and it takes the ask away: it asks first, and arms red (Review 2). */
function CancelBounty({ bountyId }: { bountyId: string }) {
  const cancel = useMutation(api.bounties.cancel);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger
        data-attr="bounty-cancel"
        render={<Button size="sm" className={cn('text-bad inset-ring-bad')} />}
      >
        Cancel bounty
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this bounty?</AlertDialogTitle>
          <AlertDialogDescription>
            Your ask comes off the lake. Reports that already answered it stay up.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && (
          <AlertDialogBody>
            <AlertDialogError title="Not canceled.">{error}</AlertDialogError>
          </AlertDialogBody>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            destructive
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await cancel({ bountyId: bountyId as Id<'bounties'> });
                setOpen(false);
              } catch (err) {
                setError(writeError(err, 'Check your connection and try again.'));
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel bounty
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
