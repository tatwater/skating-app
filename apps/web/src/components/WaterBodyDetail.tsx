import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  formatAreaAcres,
  formatSkateTime,
  humanizeEnum,
  SKATE_QUALITY_LABELS,
} from '@skating/core';
import { Link } from '@tanstack/react-router';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import { WaterBodyModeratorControls } from './admin/WaterBodyModeratorControls';
import { BountyForm } from './BountyForm';
import { BountyList } from './BountyList';
import { DirectionsButton } from './DirectionsButton';
import { DetailSkeleton, UnavailableState } from './DrawerStates';
import { FavoriteButton } from './FavoriteButton';
import { HazardForm } from './HazardForm';
import { HazardList } from './HazardList';
import { useMapSelection } from './MapSelectionContext';
import { ReportForm } from './ReportForm';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';

/**
 * Water-body detail drawer content (§D, D47) for `/water/$id`. Reads `waterBodies.get`, which
 * **follows a merge to the survivor** (a stale/merged deep link silently lands on the canonical
 * lake) and distinguishes not-found (`null`) from removed/unlisted (`{ available: false }`) so each
 * gets its own friendly state instead of a blank. Shows the name, type, imperial area (D25), and
 * the report feed newest **skate time** first; the map flies to the lake's centroid on open.
 */
export function WaterBodyDetail({
  waterBodyId,
  /** A named bay to frame instead of the whole lake (N2/D60) — set by a sub-area search hit. */
  focusSubAreaId,
}: {
  waterBodyId: string;
  focusSubAreaId?: string;
}) {
  const result = useQuery(api.waterBodies.get, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  });
  const body = result?.available ? result.body : null;
  // Only fetched when a bay was actually asked for — a `by_parent` read on a lake already open.
  const subAreas = useQuery(
    api.subAreas.listForBody,
    focusSubAreaId && body ? { waterBodyId: body._id } : 'skip',
  );
  const focusSubArea = focusSubAreaId
    ? subAreas?.find((s) => s._id === focusSubAreaId && !s.removed)
    : undefined;
  const { setFocus, setHighlightWaterBodyId } = useMapSelection();
  const [formOpen, setFormOpen] = useState(false);
  const [hazardFormOpen, setHazardFormOpen] = useState(false);
  const [bountyFormOpen, setBountyFormOpen] = useState(false);

  // Once the (possibly merge-resolved) lake loads, fly the map to it and highlight it. We use the
  // resolved `body._id` — the survivor a merged deep link redirects to — which is what the map's
  // features carry, so a `/water/<merged-id>` link still highlights the right polygon.
  useEffect(() => {
    if (!body) return;
    // A bay frames on its **own bounds**, not the lake's — Champlain zoom-to-fit is 200 km of ice,
    // which is exactly the framing that made naming bays worth doing. (Mobile has always done this;
    // web was flying to a centroid at a guessed zoom, which fits a round bay and misses a long one.)
    if (focusSubArea) {
      setFocus({
        lat: focusSubArea.centroid.lat,
        lng: focusSubArea.centroid.lng,
        bounds: focusSubArea.bbox,
      });
    } else if (!focusSubAreaId || subAreas !== undefined) {
      // Falls back to the lake once we know the bay isn't there — a `?sub=` pointing at a delisted
      // or merged-away bay used to leave the map wherever it happened to be, framing nothing. While
      // the lookup is still in flight (`subAreas === undefined`) we hold off, so the camera doesn't
      // fly to the lake and then jump to the bay a moment later.
      setFocus({ lat: body.centroid.lat, lng: body.centroid.lng, zoom: 12 });
    }
    // Highlight the parent either way: the bay is a name on this lake, not a selectable thing.
    setHighlightWaterBodyId(body._id);
  }, [body, focusSubArea, focusSubAreaId, subAreas, setFocus, setHighlightWaterBodyId]);

  if (result === undefined) return <DetailSkeleton />;

  if (result === null) {
    return (
      <UnavailableState
        title="Lake not found"
        message="We couldn't find this water body. The link may be broken."
      />
    );
  }
  if (!result.available) {
    return (
      <UnavailableState
        title="This lake isn't available"
        message="It may have been removed from the map. Try another lake nearby."
      />
    );
  }

  return (
    <>
      <SheetHeader>
        <div className="flex items-start justify-between gap-2">
          <SheetTitle>{result.body.name}</SheetTitle>
          <FavoriteButton waterBodyId={result.body._id} />
        </div>
        <SheetDescription>
          {humanizeEnum(result.body.type)}
          {result.body.surfaceAreaSqM !== undefined
            ? ` · ${formatAreaAcres(result.body.surfaceAreaSqM)}`
            : ''}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {/* Report creation + directions to a put-in (never the on-water centroid, D#7). */}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setFormOpen(true)}>Add a report</Button>
          <Button variant="outline" onClick={() => setHazardFormOpen(true)}>
            Report a hazard
          </Button>
          <Button variant="outline" onClick={() => setBountyFormOpen(true)}>
            Post a bounty
          </Button>
          <DirectionsButton waterBodyId={result.body._id} />
        </div>
        <WaterBodyModeratorControls body={result.body} />
        <BountyList waterBodyId={result.body._id} />
        <HazardList waterBodyId={result.body._id} />
        <ReportFeed
          waterBodyId={result.body._id}
          {...(focusSubArea ? { initialSubAreaId: focusSubArea._id } : {})}
        />
      </div>
      {formOpen ? (
        <ReportForm
          waterBodyId={result.body._id}
          bodyName={result.body.name}
          open={formOpen}
          onOpenChange={setFormOpen}
        />
      ) : null}
      {hazardFormOpen ? (
        <HazardForm waterBodyId={result.body._id} onClose={() => setHazardFormOpen(false)} />
      ) : null}
      {bountyFormOpen ? (
        <BountyForm
          waterBodyId={result.body._id}
          bodyName={result.body.name}
          open={bountyFormOpen}
          onOpenChange={setBountyFormOpen}
        />
      ) : null}
    </>
  );
}

/** How many per-body reports to fetch per infinite-scroll page. */
const REPORTS_PAGE_SIZE = 20;

function ReportFeed({
  waterBodyId,
  /** The bay a search hit arrived on, pre-selecting the filter — you asked about Malletts, not the lake. */
  initialSubAreaId,
}: {
  waterBodyId: Id<'waterBodies'>;
  initialSubAreaId?: string;
}) {
  // The named bays on this lake (N2/D60). Most lakes have none, and then this whole control is
  // absent rather than an empty dropdown asking "which part?" of a pond.
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  const bays = (subAreas ?? []).filter((s) => !s.removed);
  const [subAreaId, setSubAreaId] = useState<string>(initialSubAreaId ?? '');
  // A bay that was delisted since the link was made falls back to the whole lake rather than
  // filtering on an id nothing matches, which would read as "no reports here".
  const activeBay = bays.some((b) => b._id === subAreaId) ? subAreaId : '';

  const { results, status, loadMore } = usePaginatedQuery(
    api.reports.listByWaterBody,
    {
      waterBodyId,
      ...(activeBay ? { subAreaId: activeBay as Id<'waterBodySubAreas'> } : {}),
    },
    { initialNumItems: REPORTS_PAGE_SIZE },
  );
  const authorIds = [...new Set(results.map((r) => r.authorId))];
  const authors = useQuery(
    api.profiles.publicByIds,
    results.length > 0 ? { profileIds: authorIds } : 'skip',
  );

  const bayFilter =
    bays.length > 0 ? (
      <label className="flex items-center gap-2 text-foreground-muted text-xs">
        <span>Part of the lake</span>
        <select
          className="rounded-md border border-border bg-surface px-2 py-1"
          value={activeBay}
          onChange={(e) => setSubAreaId(e.target.value)}
          aria-label="Filter reports by part of the lake"
        >
          <option value="">Anywhere</option>
          {bays.map((bay) => (
            <option key={bay._id} value={bay._id}>
              {bay.name}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  if (status === 'LoadingFirstPage') return <Skeleton className="h-24 w-full" />;
  if (results.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {bayFilter}
        <p className="text-foreground-muted text-sm">
          {activeBay
            ? 'No reports from that part of the lake yet.'
            : 'No reports yet — be the first to say how it skates.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Reports
        </h3>
        {bayFilter}
      </div>
      {results.map((report) => (
        <Link key={report._id} to="/report/$id" params={{ id: report._id }} className="block">
          <Card size="sm" className="transition-colors hover:bg-surface-muted">
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground text-sm">
                  {formatSkateTime(report.skateEndTime)}
                </span>
                {report.skateQuality ? (
                  <Badge variant="secondary">{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
                ) : null}
              </div>
              {report.iceTypes.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {report.iceTypes.map((iceType) => (
                    <Badge key={iceType} variant="outline">
                      {humanizeEnum(iceType)}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <span className="text-foreground-muted text-xs">
                by {authors?.[report.authorId]?.displayName ?? '…'}
              </span>
            </CardContent>
          </Card>
        </Link>
      ))}
      {status === 'CanLoadMore' ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => loadMore(REPORTS_PAGE_SIZE)}
          className="self-center"
        >
          Load more
        </Button>
      ) : null}
      {status === 'LoadingMore' ? <Skeleton className="h-16 w-full" /> : null}
    </div>
  );
}
