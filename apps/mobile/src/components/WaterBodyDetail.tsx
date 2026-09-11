import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  buildLakeCaption,
  contourBodyKey,
  describeLakeDepth,
  formatAreaAcres,
  formatSkateTime,
  humanizeEnum,
  profileRevealEnabled,
  resolveWeatherSubArea,
  revealEmptySections,
  SKATE_QUALITY_LABELS,
  waterBodyClassLabel,
} from '@skating/core';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import type { MultiPolygon, Polygon } from 'geojson';
import { useEffect, useState } from 'react';
import { Button, H4, Paragraph, Spinner, Text, XStack, YStack } from 'tamagui';
import { cacheBody } from '../lib/bodyCache';
import { useDetailTab } from '../lib/detailTabs';
import { env } from '../lib/env';
import { cacheReports } from '../lib/reportCache';
import { AccessSection } from './AccessSection';
import { AlertStrip } from './AlertStrip';
import { BountyForm } from './BountyForm';
import { BountyList } from './BountyList';
import { DetailTabStrip } from './DetailTabStrip';
import { Badge, DetailLoading, Section, Unavailable } from './detailUi';
import { DirectionsButton, FavoriteButton } from './FavoriteButton';
import { ForecastStrip } from './ForecastStrip';
import { IceHistory } from './IceHistory';
import { LeavingNotice, useIsLeaving } from './LeavingNotice';
import { DrawerHead, DrawerPinned } from './MapDrawer';
import { useMapSelection } from './MapSelectionContext';
import { PastWeatherPanel } from './PastWeatherPanel';
import { PostedAccess } from './PostedAccess';
import { ReferenceLinks } from './ReferenceLinks';
import { ReportForm } from './ReportForm';
import { SeasonEmptyState, SeasonFilter, useResetBrowseSeason } from './SeasonFilter';
import { SubAreaSpread } from './SubAreaSpread';
import { WeatherPlacePicker } from './WeatherPlacePicker';
import { WindExposure } from './WindExposure';

/**
 * Water-body detail drawer (§F, D47) for `/water/[id]`, the mobile mirror of web's `WaterBodyDetail`.
 * Reads `waterBodies.get`, which **follows a merge to the survivor** (a stale/merged deep link
 * silently lands on the canonical lake) and distinguishes not-found (`null`) from removed/unlisted
 * (`{ available: false }`) so each gets its own friendly state. Shows name, type, imperial area
 * (D25), and the report feed newest **skate time** first; the map flies to the lake's centroid on
 * open. "Add a report" swaps the feed for the create form in place (D47), kept mounted in this same
 * sheet so its state survives the put-in-pin peek.
 */
export function WaterBodyDetail({
  waterBodyId,
  trackDraftId,
  activityId,
  focusSubAreaId,
}: {
  waterBodyId: string;
  /** A named bay to frame instead of the whole lake (N2/D60) — set by a sub-area search hit. */
  focusSubAreaId?: string;
  /**
   * A just-finished recording to file this report against (Phase 8). When present the form opens
   * straight away — the skater tapped "Report this skate", and making them find the button again
   * would be the moment the whole record→report loop leaks people.
   */
  trackDraftId?: string;
  /** A synced skate to attach (N6f) — the server id, from the You tab's unreported list. */
  activityId?: string;
}) {
  const result = useQuery(api.waterBodies.get, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  });
  const body = result?.available ? result.body : null;
  // Always fetched once the lake is known — a `by_parent` read that returns nothing on the ~99% of
  // bodies with no bays. The Planning tab needs it on every giant to pick the bay its weather is
  // about (N6h open question 5); the report feed subscribes to the same query, so it is deduped.
  const subAreas = useQuery(api.subAreas.listForBody, body ? { waterBodyId: body._id } : 'skip');
  const focusSubArea = focusSubAreaId
    ? subAreas?.find((s) => s._id === focusSubAreaId && !s.removed)
    : undefined;
  // The bay the weather panel is about: the route's bay, else the most prominent, else the lake
  // itself. `undefined` while the bays are still loading, so the panel holds rather than fetching
  // the lake's cell and then the bay's. Never written back to the route — see `WeatherPlacePicker`.
  const liveBays = (subAreas ?? []).filter((s) => !s.removed);
  // The report feed's bay filter, held here because the feed unmounts with its tab (see
  // `ReportFeed`). Seeded from the route's `?sub=` — the raw param, available on the first render,
  // where the resolved bay object is not — and re-seeded whenever the route's bay changes, **in both
  // directions**: a bay named lands the feed on it, and a bay removed (`?sub=` dropped on the same
  // lake) returns it to the whole lake, because that is what the route just said. The dropdown then
  // refines it locally without touching the route, and holds until the route speaks again.
  const [feedBayId, setFeedBayId] = useState<string>(focusSubAreaId ?? '');
  useEffect(() => {
    setFeedBayId(focusSubAreaId ?? '');
  }, [focusSubAreaId]);
  const weatherBay =
    subAreas === undefined ? undefined : resolveWeatherSubArea(liveBays, focusSubAreaId);
  const { setFocus, setHighlightWaterBodyId, setContourBodyKey, contourCredit } = useMapSelection();
  const [formOpen, setFormOpen] = useState(trackDraftId !== undefined || activityId !== undefined);
  const [bountyFormOpen, setBountyFormOpen] = useState(false);
  const leaving = useIsLeaving();
  const [tab, setTab] = useDetailTab();
  // The season selector lives on the Reporting tab, but the season it picks governs the whole lake
  // view (D63) — so its reset is keyed to this sheet's lifecycle, not the tab's.
  useResetBrowseSeason(waterBodyId);
  // Same whole-table fetch as web — five rows of aggregate geography, so the caption stays a pure
  // function of (body, basis) rather than needing a second round trip to learn which state to ask.
  const regionStats = useQuery(api.regionStats.list, {});

  // Offline read-cache (decision #8): stash this opened lake's freshest reports as feed cards so they
  // read back on the ice with no signal. Skips until the (merge-resolved) body id is known.
  const openedLakeCards = useQuery(
    api.reports.recentCardsForBodies,
    body ? { waterBodyIds: [body._id] } : 'skip',
  );
  useEffect(() => {
    if (openedLakeCards && openedLakeCards.length > 0) cacheReports(openedLakeCards);
  }, [openedLakeCards]);

  // Once the (possibly merge-resolved) lake loads, fly the map to it and highlight it by the
  // *resolved* `_id` — the survivor a merged deep link redirects to, which is what the map carries.
  //
  // What the camera should frame, as a *stable signature* rather than the objects behind it (the
  // same shape as web): a live `sub=` bay → that bay; no `sub=`, or one we now know is not a live
  // bay → the lake; a `sub=` whose lookup is still in flight → hold, so the camera does not fly to
  // the lake and then jump to the bay when the bay list lands ~100 ms later.
  // ⚠ Keyed on ids because `subAreas` is now fetched on every lake and both it and `body` are
  // reactive results whose identity changes on every re-emit; as effect dependencies they re-flew a
  // reader who had panned away.
  const focusKey = !body
    ? null
    : focusSubArea
      ? `sub:${focusSubArea._id}`
      : !focusSubAreaId || subAreas !== undefined
        ? `body:${body._id}`
        : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is the stable signature of (body, focusSubArea, focusSubAreaId, subAreas) — see above.
  useEffect(() => {
    if (!body || focusKey === null) return;
    // Pass the lake's bbox so the map zoom-to-fits it into the area above the drawer (falls back to
    // the centroid for anything without bounds).
    // A bay frames on its own bounds, not the lake's — Champlain zoom-to-fit is 200 km of ice,
    // which is exactly the framing that made naming bays worth doing.
    setFocus(
      focusSubArea
        ? {
            lat: focusSubArea.centroid.lat,
            lng: focusSubArea.centroid.lng,
            bounds: focusSubArea.bbox,
          }
        : { lat: body.centroid.lat, lng: body.centroid.lng, bounds: body.bbox },
    );
    setHighlightWaterBodyId(body._id);
    // And mount the bathymetry layer for this lake (N6b/D81). Keyed by the OSM id the contour
    // tiles carry, not by the Convex `_id` the highlight uses — a re-import that churned ids would
    // otherwise silently blank the layer on every lake at once. Only the *lake* sheet does this:
    // D81 makes contours a property of this view, not of every view that selects a body.
    setContourBodyKey(contourBodyKey(body.externalId, body._id));
  }, [focusKey, setFocus, setHighlightWaterBodyId, setContourBodyKey]);

  // Cache this viewed lake's reference data on-device (F2 Layer 2) so it can be GPS-resolved
  // offline for a no-signal report. Best-effort; the sqlite write never blocks viewing. Its own
  // effect, on the body itself, so an edit to the lake re-caches without re-flying the camera.
  useEffect(() => {
    if (!body) return;
    cacheBody({
      waterBodyId: body._id,
      name: body.name,
      states: body.states,
      polygon: body.polygon as unknown as Polygon | MultiPolygon,
      centroid: body.centroid,
      surfaceAreaSqM: body.surfaceAreaSqM,
    });
  }, [body]);

  if (result === undefined) return <DetailLoading />;
  if (result === null) {
    return (
      <Unavailable
        title="Lake not found"
        message="We couldn't find this water body. The link may be broken."
      />
    );
  }
  if (!result.available) {
    return (
      <Unavailable
        title="This lake isn't available"
        message="It may have been removed from the map. Try another lake nearby."
      />
    );
  }

  const depth = describeLakeDepth(result.body);
  const caption = buildLakeCaption(result.body, regionStats);
  // N6c-2's reveal flag — see `profileReveal` in @skating/core. Forced off against production
  // regardless of the constant, so the device build (a release build pointing at dev) still shows
  // every slot while a real skater never can.
  const reveal = revealEmptySections(profileRevealEnabled(env.convexUrl));

  const formShowing = formOpen || bountyFormOpen;

  return (
    <>
      {/* The head: what scrolls away above the pinned strip (see `DrawerHead` in MapDrawer). The
          screen's own name, its actions and the NWS alert — the alert above the strip, always, so
          a warning is never one tap away from unseen. Padding is carried here because the slot
          itself has none: an empty slot on another screen must cost no height. */}
      <DrawerHead>
        <YStack gap="$3" paddingHorizontal={16} paddingTop={16} paddingBottom={12}>
          <YStack gap="$1">
            <XStack justifyContent="space-between" alignItems="center" gap="$2">
              <H4 color="$foreground" flex={1}>
                {result.body.name}
              </H4>
              <FavoriteButton waterBodyId={result.body._id} />
            </XStack>
            <Text color="$foregroundMuted">
              {waterBodyClassLabel(result.body.type)}
              {result.body.surfaceAreaSqM !== undefined
                ? ` · ${formatAreaAcres(result.body.surfaceAreaSqM)}`
                : ''}
              {depth ? ` · ${depth.text}` : ''}
            </Text>
            {/* Provenance under the numbers, same as web: absent for most bodies, and a caveat inline in
                the type/area line would read as clutter on the minority that do have a depth. */}
            {depth ? (
              <Text color="$foregroundMuted" fontSize="$1">
                {depth.caption}
              </Text>
            ) : null}
            {/* The derived profile (N6c/C), assembled by the same @skating/core function web calls so
                the two surfaces cannot drift. Nothing renders when there is nothing to say. */}
            {caption ? (
              <Paragraph color="$foregroundMuted" fontSize={14} paddingTop="$1">
                {caption}
              </Paragraph>
            ) : null}
            <DirectionsButton waterBodyId={result.body._id} />
          </YStack>
          {formShowing ? null : (
            <>
              {/* Report creation + bounty posting surfaced in place (D47). Both close while a
                  deletion is pending (D62 amendment); the feed below stays fully readable. */}
              {leaving ? (
                <LeavingNotice />
              ) : (
                <>
                  <Button
                    backgroundColor="$primary"
                    color="$primaryForeground"
                    onPress={() => setFormOpen(true)}
                  >
                    Add a report
                  </Button>
                  <Button variant="outlined" onPress={() => setBountyFormOpen(true)}>
                    Post a bounty
                  </Button>
                </>
              )}
              {/* Official NWS alerts (N6c/B5) ABOVE the tab strip, always visible — a warning from the
                  local forecast office outranks both our observations and anybody's forecast, and a
                  tabbed alert is an alert you can be one tap away from not seeing (N6h/H). */}
              <AlertStrip waterBodyId={result.body._id} reveal={reveal} />
            </>
          )}
        </YStack>
      </DrawerHead>
      {/* The strip, pinned: the second scroll-view child sticks once scrolled to, and this is the
          only way a strip nested inside a routed screen can get there (`DrawerPinned`). Gone while
          a form is open — the form replaces the tabs, and a pinned strip over a form would switch
          to a tab the form is standing in for. */}
      {formShowing ? null : (
        <DrawerPinned>
          <YStack paddingHorizontal={16} paddingBottom="$2">
            {/* The three sub-tabs (N6h/H), the same groups as web over the same core vocabulary:
                Overview = machine-compiled facts about the body, Reporting = user-supplied this
                season, Planning = the trip decision. Nothing in the tab content is new — the sections
                that used to stack flat are grouped, in their old relative order, so every "above X
                because Y" argument still holds within its tab. Selection persists across bodies for
                the session (`useDetailTab`). Only the active group is mounted, so the others'
                queries are not subscribed while nobody is looking. */}
            <DetailTabStrip value={tab} onChange={setTab} />
          </YStack>
        </DrawerPinned>
      )}
      <YStack gap="$3">
        {formOpen ? (
          <ReportForm
            waterBodyId={result.body._id}
            bodyName={result.body.name}
            {...(trackDraftId !== undefined ? { trackDraftId } : {})}
            {...(activityId !== undefined ? { activityId } : {})}
            onClose={() => setFormOpen(false)}
          />
        ) : bountyFormOpen ? (
          <BountyForm
            waterBodyId={result.body._id}
            bodyName={result.body.name}
            onClose={() => setBountyFormOpen(false)}
          />
        ) : tab === 'overview' ? (
          <>
            {/* What the sign says (N6e). Its own section rather than a row inside AccessSection,
                      which renders nothing when a body has no mapped put-ins and would swallow the rule
                      on exactly the remote reservoir that posts one. ⚠ The put-ins are on Planning: the
                      taxonomy puts permission with the body and the route with the trip, which
                      knowingly splits the "permission precedes access" adjacency the flat sheet had. */}
            <PostedAccess
              rule={result.body.postedAccess}
              coord={result.body.interiorPoint ?? result.body.centroid}
              reveal={reveal}
            />
            {/* Winter wind (N7-3 / D90) — a climatology, what the last five winters did, which is
                      exactly why it is a fact about the body rather than a planning input. Renders
                      nothing without a rose, and says nothing about safety (D145). */}
            <WindExposure body={result.body} />
            {/* Reference links (N6c/B), below our own content and above the credits. Every one
                      opens in-app via `openBrowserAsync` (D76), never by ejecting the skater into
                      Safari. */}
            <ReferenceLinks body={result.body} reveal={reveal} />
            {/* The bathymetry credit (N6b §5), last and absent on the great majority of lakes no
                      agency ever surveyed. "How far away can we put it" resolved to *here*, and that is
                      not a compromise: nothing requires a contour credit on the map surface, and this
                      is where the depth provenance above and the Open-Meteo credit already live.
                      Provenance only — D82 means no sentence here about what a depth implies for ice. */}
            {contourCredit ? (
              <Text color="$foregroundMuted" fontSize="$1">
                {contourCredit}
              </Text>
            ) : null}
          </>
        ) : tab === 'reporting' ? (
          <>
            <SeasonFilter waterBodyId={result.body._id} />
            <BountyList waterBodyId={result.body._id} />
            {/* The lake page and nowhere else (§9.1) — not the map, the feed, notifications or
                      the recommended strip. A mark on the map means somebody reported this; an advisory
                      has no reporter this season. */}
            <IceHistory waterBodyId={result.body._id} />
            <ReportFeed
              waterBodyId={result.body._id}
              subAreaId={feedBayId}
              onSubAreaIdChange={setFeedBayId}
            />
          </>
        ) : (
          <>
            {/* How you get onto the ice (N6d) — above the weather, because it decides whether the
                      trip is possible at all, where the weather decides whether it is worth making.
                      Absent on the great majority of bodies OSM has never mapped access for. */}
            <AccessSection waterBodyId={result.body._id} />
            {/* Which place on the lake the weather below is about — a scope line and chips on a
                      giant with named bays, nothing on everything else (open question 5). */}
            {/* The lake's spread across its bays, with the ends named as tap targets (open question 5).
                      Reads Tier B, so it costs no fetch; renders nothing until the season sweep has rows for two
                      of this lake's bays. Only asked for on a lake that has two bays to compare. */}
            {liveBays.length >= 2 ? <SubAreaSpread waterBodyId={result.body._id} /> : null}
            <WeatherPlacePicker
              waterBodyId={result.body._id}
              bays={liveBays}
              selectedId={weatherBay?._id ?? null}
            />
            {/* What the ice has been through (N6h / D153) — ABOVE the forecast, matching the web
                      column and the same authority ordering: alert > observation > prediction. It draws
                      the same timeline the web app does: the geometry and the sentences both live in
                      core. */}
            <PastWeatherPanel
              waterBodyId={result.body._id}
              pending={weatherBay === undefined}
              {...(weatherBay ? { subAreaId: weatherBay._id } : {})}
            />
            {/* The forward forecast (N6c/B5b) — the other half of the weather-since timeline. */}
            <ForecastStrip
              waterBodyId={result.body._id}
              pending={weatherBay === undefined}
              {...(weatherBay ? { subAreaId: weatherBay._id } : {})}
              reveal={reveal}
            />
          </>
        )}
      </YStack>
    </>
  );
}

/** How many per-body reports to fetch per infinite-scroll page. */
const REPORTS_PAGE_SIZE = 20;

function ReportFeed({
  waterBodyId,
  subAreaId,
  onSubAreaIdChange,
}: {
  waterBodyId: Id<'waterBodies'>;
  /**
   * The bay filter, **owned by the lake drawer** rather than by this feed. The feed lives on the
   * Reporting tab and unmounts on every tab switch; a filter kept here as local state was reset to
   * the route's bay (or "Anywhere") each time the reader glanced at Planning and came back. Seeded
   * from the route's `?sub=` and following it, so a search hit or the weather picker lands the feed
   * on the same bay. `''` is the whole lake.
   */
  subAreaId: string;
  onSubAreaIdChange: (subAreaId: string) => void;
}) {
  const router = useRouter();
  // The named bays on this lake (N2/D60). Most lakes have none, and then the control is absent
  // rather than an empty chip row asking "which part?" of a pond.
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  const bays = (subAreas ?? []).filter((s) => !s.removed);
  const setSubAreaId = onSubAreaIdChange;
  // A bay delisted since the link was made falls back to the whole lake, rather than filtering on an
  // id nothing matches — which would read as "no reports here".
  const activeBay = bays.some((b) => b._id === subAreaId) ? subAreaId : '';

  // The season on screen (D63), shared with the map so the pins behind this sheet belong to the same
  // winter as the list in it. `null` — this season — is the default the sheet always opens in.
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

  // Chips rather than a picker: there are at most a handful of bays, and a tap is cheaper than a
  // modal on a phone someone is holding in a glove.
  const bayFilter =
    bays.length > 0 ? (
      <XStack gap="$2" flexWrap="wrap">
        {[{ _id: '', name: 'Anywhere' }, ...bays].map((bay) => (
          <Text
            key={bay._id || 'all'}
            accessibilityRole="button"
            accessibilityLabel={`Show reports from ${bay.name}`}
            accessibilityState={{ selected: activeBay === bay._id }}
            onPress={() => setSubAreaId(bay._id)}
            paddingHorizontal="$2"
            paddingVertical="$1"
            borderRadius="$3"
            borderWidth={1}
            borderColor={activeBay === bay._id ? '$primary' : '$border'}
            color={activeBay === bay._id ? '$primary' : '$foregroundMuted'}
            fontSize={13}
          >
            {bay.name}
          </Text>
        ))}
      </XStack>
    ) : null;

  if (status === 'LoadingFirstPage') return <DetailLoading />;
  if (results.length === 0) {
    return (
      <YStack gap="$2">
        {bayFilter}
        {activeBay ? (
          <Paragraph color="$foregroundMuted">No reports from that part of the lake yet.</Paragraph>
        ) : (
          <SeasonEmptyState browseSeason={browseSeason} currentSeason={seasons?.current} />
        )}
      </YStack>
    );
  }

  return (
    <YStack gap="$2">
      {bayFilter}
      <Section label="Reports">
        <YStack gap="$2">
          {results.map((report) => (
            <YStack
              key={report._id}
              gap="$2"
              padding="$3"
              borderWidth={1}
              borderColor="$border"
              borderRadius="$4"
              backgroundColor="$surfaceMuted"
              pressStyle={{ opacity: 0.7 }}
              onPress={() =>
                router.navigate({ pathname: '/report/[id]', params: { id: report._id } })
              }
            >
              <XStack justifyContent="space-between" alignItems="center" gap="$2">
                <Text color="$foreground">{formatSkateTime(report.skateEndTime)}</Text>
                {report.skateQuality ? (
                  <Badge tone="solid">{SKATE_QUALITY_LABELS[report.skateQuality]}</Badge>
                ) : null}
              </XStack>
              {report.iceTypes.length > 0 ? (
                <XStack gap="$1.5" flexWrap="wrap">
                  {report.iceTypes.map((iceType) => (
                    <Badge key={iceType}>{humanizeEnum(iceType)}</Badge>
                  ))}
                </XStack>
              ) : null}
              <Text color="$foregroundMuted" fontSize={12}>
                by {authors?.[report.authorId]?.displayName ?? '…'}
              </Text>
            </YStack>
          ))}
          {status === 'CanLoadMore' ? (
            <Button size="$3" variant="outlined" onPress={() => loadMore(REPORTS_PAGE_SIZE)}>
              Load more
            </Button>
          ) : null}
          {status === 'LoadingMore' ? (
            <YStack padding="$2" alignItems="center">
              <Spinner color="$primary" />
            </YStack>
          ) : null}
        </YStack>
      </Section>
    </YStack>
  );
}
