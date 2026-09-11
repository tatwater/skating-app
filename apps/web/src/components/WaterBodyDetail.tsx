import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  AERIAL_ATTRIBUTION,
  buildLakeCaption,
  contourBodyKey,
  DETAIL_TAB_LABELS,
  DETAIL_TABS,
  describeLakeDepth,
  formatAerialCaptureDate,
  formatAreaAcres,
  formatSkateTime,
  humanizeEnum,
  isLeaving,
  profileRevealEnabled,
  resolveWeatherSubArea,
  revealEmptySections,
  revealPlaceholder,
  SKATE_QUALITY_LABELS,
  waterBodyClassLabel,
  waterBodyDisplayName,
} from '@skating/core';
import { Link } from '@tanstack/react-router';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import { useDetailTab } from '../lib/detailTabs';
import { env } from '../lib/env';
import { AccessSection } from './AccessSection';
import { AlertStrip } from './AlertStrip';
import { WaterBodyModeratorControls } from './admin/WaterBodyModeratorControls';
import { BountyForm } from './BountyForm';
import { BountyList } from './BountyList';
import { PanelDescription, PanelHeader, PanelTitle } from './DetailPanel';
import { DirectionsButton } from './DirectionsButton';
import { DetailSkeleton, UnavailableState } from './DrawerStates';
import { FavoriteButton } from './FavoriteButton';
import { ForecastStrip } from './ForecastStrip';
import { HazardForm } from './HazardForm';
import { HazardList } from './HazardList';
import { IceHistory } from './IceHistory';
import { LeavingNotice } from './LeavingNotice';
import { useMapSelection } from './MapSelectionContext';
import { PastWeatherPanel } from './PastWeatherPanel';
import { PostedAccess } from './PostedAccess';
import { PublicAccessSection } from './PublicAccessSection';
import { ReferenceLinks } from './ReferenceLinks';
import { ReportForm } from './ReportForm';
import { SeasonEmptyState, SeasonFilter } from './SeasonFilter';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Skeleton } from './ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { WeatherPlacePicker } from './WeatherPlacePicker';
import { WindExposure } from './WindExposure';

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
  // Always fetched once the lake is known — a `by_parent` read that returns nothing on the ~99% of
  // bodies with no bays. It used to be skipped unless a bay was asked for; now the Planning tab needs
  // it on every giant to pick the bay its weather is about (N6h open question 5), and the report feed
  // subscribes to the same query anyway, so the client dedupes it.
  const subAreas = useQuery(api.subAreas.listForBody, body ? { waterBodyId: body._id } : 'skip');
  const focusSubArea = focusSubAreaId
    ? subAreas?.find((s) => s._id === focusSubAreaId && !s.removed)
    : undefined;
  // The bay the weather panel is about: the route's bay, else the most prominent, else the lake
  // itself. `undefined` while the bays are still loading, so the panel does not fetch the lake's
  // cell and then the bay's a moment later. Never written back to the URL — see `WeatherPlacePicker`.
  const liveBays = (subAreas ?? []).filter((s) => !s.removed);
  const weatherBay =
    subAreas === undefined ? undefined : resolveWeatherSubArea(liveBays, focusSubAreaId);
  const {
    setFocus,
    setHighlightWaterBodyId,
    setContourBodyKey,
    contourCredit,
    imageryOn,
    aerialCapturedAt,
  } = useMapSelection();
  // Mirrors the server's `requireContributor` — see `LeavingNotice`.
  const leaving = isLeaving(useQuery(api.profiles.current, {}));
  // Five rows of aggregate geography, fetched whole rather than per-state: it keeps the caption a
  // pure function of (body, basis) on both clients, and the alternative is a second round trip to
  // learn which state to ask about.
  const regionStats = useQuery(api.regionStats.list, {});
  const [formOpen, setFormOpen] = useState(false);
  const [hazardFormOpen, setHazardFormOpen] = useState(false);
  const [bountyFormOpen, setBountyFormOpen] = useState(false);
  const [tab, setTab] = useDetailTab();

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
    // And mount the bathymetry layer for this lake (N6b/D81). Keyed by the OSM id the contour tiles
    // carry, not by the Convex `_id` the highlight uses — a re-import that churned ids would
    // otherwise silently blank the layer on every lake at once. Only the *lake* drawer does this:
    // D81 makes contours a property of this view, not of every view that happens to select a body.
    setContourBodyKey(contourBodyKey(body.externalId, body._id));
  }, [
    body,
    focusSubArea,
    focusSubAreaId,
    subAreas,
    setFocus,
    setHighlightWaterBodyId,
    setContourBodyKey,
  ]);

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

  const depth = describeLakeDepth(result.body);
  const caption = buildLakeCaption(result.body, regionStats);
  // N6c-2's reveal flag. Every surface below is built to render nothing when it has nothing to say,
  // which is right for skaters and hostile to testing — on this corpus almost all of them are
  // invisible, and "invisible because there is no data" looks exactly like "invisible because it
  // broke". Under the reveal each states its absence instead. It never invents a value.
  const reveal = revealEmptySections(profileRevealEnabled(env.convexUrl));

  return (
    <>
      <PanelHeader>
        <div className="flex items-start justify-between gap-2">
          <PanelTitle>{waterBodyDisplayName(result.body.name)}</PanelTitle>
          <FavoriteButton waterBodyId={result.body._id} />
        </div>
        <PanelDescription>
          {waterBodyClassLabel(result.body.type)}
          {result.body.surfaceAreaSqM !== undefined
            ? ` · ${formatAreaAcres(result.body.surfaceAreaSqM)}`
            : ''}
          {depth ? ` · ${depth.text}` : ''}
        </PanelDescription>
        {/* Provenance sits under the numbers rather than beside them: most bodies have no depth at all
            (73% of the corpus is below every source's area floor), so this line is absent far more often
            than present, and a caveat inline in the description would read as clutter when it IS there. */}
        {depth ? (
          <p className="text-muted-foreground text-xs" title={depth.caption}>
            {depth.caption}
          </p>
        ) : null}
        {/* The derived profile (N6c/C). Renders NOTHING — no heading, no empty section — when
            there is nothing to say, which is most of the corpus and is the correct outcome rather
            than a gap to fill with hedged filler. */}
        {caption ? (
          <p className="pt-1 text-muted-foreground text-sm">{caption}</p>
        ) : reveal ? (
          <p className="pt-1 text-muted-foreground text-sm italic">
            {revealPlaceholder('profile caption')}
          </p>
        ) : null}
        {depth ? null : reveal ? (
          <p className="text-muted-foreground text-xs italic">{revealPlaceholder('depth')}</p>
        ) : null}
      </PanelHeader>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {/* Report creation + directions to a put-in (never the on-water centroid, D#7).
            A pending deletion removes all three composers (D62 amendment) and keeps directions:
            getting to the lake isn't a contribution, and this drawer is still worth reading. */}
        <div className="flex flex-wrap gap-2">
          {leaving ? null : (
            <>
              <Button onClick={() => setFormOpen(true)}>Add a report</Button>
              <Button variant="outline" onClick={() => setHazardFormOpen(true)}>
                Report a hazard
              </Button>
              <Button variant="outline" onClick={() => setBountyFormOpen(true)}>
                Post a bounty
              </Button>
            </>
          )}
          <DirectionsButton waterBodyId={result.body._id} />
        </div>
        {leaving ? <LeavingNotice /> : null}
        {/* Official NWS alerts (N6c/B5) ABOVE the tab strip, always visible — a warning from the
            local forecast office outranks both our observations and anybody's forecast, and a tabbed
            alert is an alert you can be one tap away from not seeing. This is what preserves the
            authority ordering (alert > observation > prediction) under the three-tab IA (N6h/H). */}
        <AlertStrip waterBodyId={result.body._id} reveal={reveal} />
        {/* The three sub-tabs (N6h/H, open question 4). Nothing below is new: the panels that used to
            stack flat are grouped by the founder's taxonomy — Overview = machine-compiled facts about
            the body, Reporting = user-supplied this season, Planning = the trip decision — and keep
            their relative order inside each group, so every "above X because Y" argument in the
            comments still holds within its tab. The selection persists across bodies for the session
            (`useDetailTab`). The strip is sticky inside the panel's scroll container: it survives the
            header scrolling away without sitting above the lake's own name. */}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList
            variant="line"
            className="sticky top-0 z-10 w-full border-b bg-background pb-1"
            aria-label="Lake detail sections"
          >
            {DETAIL_TABS.map((id) => (
              <TabsTrigger key={id} value={id}>
                {DETAIL_TAB_LABELS[id]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview" className="flex flex-col gap-4">
            {/* Whether you may be here at all (N6f) — above the posted hours, because "there is no
                lawful way in" outranks "and it closes at sunset". Annotates only: a ruling dims the
                lake on the map and demotes it, and disables nothing on this page. */}
            <PublicAccessSection body={result.body} />
            {/* What the sign says (N6e). Its own strip rather than a row inside AccessSection, which
                renders nothing when a body has no mapped put-ins and would otherwise swallow the rule
                on exactly the remote reservoir that posts one. ⚠ The put-ins themselves are on
                Planning: the taxonomy puts permission with the body and the route with the trip, and
                that knowingly splits the "permission precedes access" adjacency the flat list had. */}
            <PostedAccess
              rule={result.body.postedAccess}
              coord={result.body.interiorPoint ?? result.body.centroid}
              reveal={reveal}
            />
            {/* Winter wind (N7-3 / D90). A climatology rather than a condition — what the last five
                winters did — which is exactly why it is a fact about the body and not a planning
                input. Renders nothing on the ~56% of the corpus with no rose, and says nothing about
                safety (D145). */}
            <WindExposure body={result.body} />
            <WaterBodyModeratorControls body={result.body} />
            {/* Reference links (N6c/B), below our own content and above the credits. Everything here
                leaves the app, so it sits after everything a skater came for — and it renders nothing
                at all on a body with no coordinate and no regional community. */}
            <ReferenceLinks body={result.body} reveal={reveal} />
            {/* The bathymetry credit (N6b §5), last and absent on the great majority of lakes no
                agency ever surveyed. "How far away can we put it" resolved to *here*, and that is not
                a compromise: nothing requires a contour credit on the map surface, and this is where
                the depth provenance above and the Open-Meteo credit already live, so someone asking
                where a number came from looks in one place. Provenance only — D82 means there is no
                sentence here about what a depth implies for ice. */}
            {contourCredit ? (
              <p className="text-foreground-muted text-xs">{contourCredit}</p>
            ) : null}
            {/* The aerial credit, alongside the bathymetry one and for the same reason: somebody
                asking where something came from should find every answer in one place. The map's ⓘ
                carries the legally-required copy (`mapCanvas`); this is the discoverable copy, and it
                adds the thing the control cannot — **when the photograph was taken**, which on a
                source flown every 2–3 years in midsummer is the difference between reading the
                landscape and misreading the season (D147). Rendered only while the reveal is on,
                because a credit for a layer nobody is looking at is noise. */}
            {imageryOn ? (
              <p className="text-foreground-muted text-xs">
                Aerial imagery: {AERIAL_ATTRIBUTION}
                {/* The month, where the panel's heading says the season: somebody reading a
                    provenance block came for *when*, and `formatAerialSeason`'s coarser form is for
                    the slot it shares with the archive's own winters. One instant, two grammars. */}
                {aerialCapturedAt === null
                  ? ''
                  : ` — flown ${formatAerialCaptureDate(aerialCapturedAt)}`}
              </p>
            ) : null}
          </TabsContent>
          <TabsContent value="reporting" className="flex flex-col gap-4">
            <SeasonFilter waterBodyId={result.body._id} />
            <BountyList waterBodyId={result.body._id} />
            {/* Above the hazard list, and nowhere else — not the map, the feed, notifications, the
                recommended strip or search. The map is where a mark means somebody reported this,
                and an advisory has no reporter this season (§9.1). */}
            <IceHistory waterBodyId={result.body._id} />
            <HazardList waterBodyId={result.body._id} />
            <ReportFeed
              waterBodyId={result.body._id}
              {...(focusSubArea ? { initialSubAreaId: focusSubArea._id } : {})}
            />
          </TabsContent>
          <TabsContent value="planning" className="flex flex-col gap-4">
            {/* How you get onto the ice (N6d) — above the weather, because it decides whether the
                trip is possible at all, where the weather decides whether it is worth making. Renders
                nothing on the great majority of bodies OSM has never mapped access for. */}
            <AccessSection waterBodyId={result.body._id} />
            {/* Which place on the lake the weather below is about — a scope line and a switcher on a
                giant with named bays, nothing on everything else (open question 5). */}
            <WeatherPlacePicker
              waterBodyId={result.body._id}
              bays={liveBays}
              selectedId={weatherBay?._id ?? null}
            />
            {/* What the ice has been through (N6h / D153) — ABOVE the forecast, because the
                authority ordering this column encodes is alert > observation > prediction, and a
                week of recorded weather is an observation. It is also the half a general weather app
                cannot give you, which is why the phase exists. */}
            <PastWeatherPanel
              waterBodyId={result.body._id}
              pending={weatherBay === undefined}
              {...(weatherBay ? { subAreaId: weatherBay._id } : {})}
            />
            {/* The forward forecast (N6c/B5b) — the other half of the weather-since timeline, and
                the half that answers "should I bother driving". */}
            <ForecastStrip
              waterBodyId={result.body._id}
              pending={weatherBay === undefined}
              {...(weatherBay ? { subAreaId: weatherBay._id } : {})}
              reveal={reveal}
            />
          </TabsContent>
        </Tabs>
      </div>
      {formOpen ? (
        <ReportForm
          waterBodyId={result.body._id}
          bodyName={waterBodyDisplayName(result.body.name)}
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
          bodyName={waterBodyDisplayName(result.body.name)}
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

  // The season being browsed (D63), shared with the map so the pins and the paths on screen belong to
  // the same winter as this list. `null` — this season — is the default and the only state the drawer
  // opens in.
  const { browseSeason } = useMapSelection();
  const seasons = useQuery(api.reports.seasonsForBody, { waterBodyId });
  const { results, status, loadMore } = usePaginatedQuery(
    api.reports.listByWaterBody,
    {
      waterBodyId,
      ...(activeBay ? { subAreaId: activeBay as Id<'waterBodySubAreas'> } : {}),
      ...(browseSeason === null ? {} : { season: browseSeason }),
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
        {activeBay ? (
          <p className="text-foreground-muted text-sm">
            No reports from that part of the lake yet.
          </p>
        ) : (
          <SeasonEmptyState browseSeason={browseSeason} currentSeason={seasons?.current} />
        )}
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
