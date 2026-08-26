import {
  Camera,
  type CameraRef,
  type FilterSpecification,
  GeoJSONSource,
  Layer,
  Map as MapGL,
  type PressEvent,
  type PressEventWithFeatures,
  VectorSource,
  type VectorSourceRef,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  APPROACH_LAYER_ID,
  APPROACH_SOURCE_ID,
  applyDraftMapClick,
  approachesToFeatureCollection,
  approachLinePaint,
  type BBox,
  formatSeasonLabel,
  holdFrames,
  isRegionOffscreen,
  NO_HELD_FRAMES,
  prefetchFrames,
  SUB_AREA_MIN_RENDER_ZOOM,
  withAccessDim,
} from '@skating/core';
import { useQuery } from 'convex/react';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import type { MultiPolygon, Polygon } from 'geojson';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { LayoutChangeEvent, NativeSyntheticEvent } from 'react-native';
import { StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cacheBody } from '../lib/bodyCache';
import {
  CONTOUR_BEFORE_LAYER_ID,
  CONTOUR_FADE_MS,
  CONTOUR_LAYER_ID,
  CONTOUR_MIN_ZOOM,
  CONTOUR_OPACITY,
  CONTOUR_PALETTE,
  CONTOUR_SOURCE_ID,
  CONTOUR_SOURCE_LAYER,
  type ContourFeatureProperties,
  contourColorExpression,
  contourCredit,
  contourFilter,
  contourSourceSpec,
  contourWidthExpression,
  formatContourCredit,
  maxContourDepthFt,
} from '../lib/contourMap';
import { env } from '../lib/env';
import {
  bodyFeaturesToFeatureCollection,
  CONFIRMED_HAZARD_FILTER,
  HAZARD_PALETTE,
  hazardColorExpression,
  hazardDraftToFeatureCollection,
  hazardFillOpacityExpression,
  hazardsToFeatureCollection,
  PROVISIONAL_DASH_ARRAY,
  PROVISIONAL_HAZARD_FILTER,
} from '../lib/hazardMap';
import { ensureForegroundPermission } from '../lib/location';
import { ensureOfflineBasemap, resolveBasemapSource } from '../lib/offlineBasemap';
import {
  APPROACH_LINE_COLOR,
  boundsToViewport,
  buildMapStyle,
  DEMO_PMTILES_URL,
  FAVORITE_OUTLINE_COLOR,
  frameForCoord,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  MAP_FLAVORS,
  NORTHEAST_REGION_BOUNDS,
  PHOTO_PIN_COLOR,
  PUT_IN_MARKER_DERIVED_COLOR,
  PUT_IN_MARKER_OFFICIAL_COLOR,
  PUT_IN_MARKER_OSM_COLOR,
  PUT_IN_PIN_COLOR,
  putInsToFeatureCollection,
  SUB_AREA_PALETTE,
  subAreasToFeatureCollection,
  TRACK_PALETTE,
  WATER_PALETTE,
  waterBodiesToFeatureCollection,
  zoomForViewport,
} from '../lib/waterMap';
import { FreezeUpFrames } from './FreezeUpFrames';
import { FreezeUpScrubber } from './FreezeUpScrubber';
import { ImageryDock } from './ImageryDock';
import { coveredFractionForIndex, DRAWER_PEEK } from './MapDrawer';
import { useMapSelection } from './MapSelectionContext';
import { OnIceDock } from './OnIceDock';
import { ReturnToRegion } from './ReturnToRegion';
import { useFreezeUpTimeline } from './useFreezeUpTimeline';

/**
 * Interactive native MapLibre map — the read side of the Phase 2 loop (§F, D5/D6/D47/D49), the
 * mobile mirror of web's `MapView`. This is the imperative native shell (excluded from unit tests
 * like web's WebGL shell); all pure logic (style, feature/viewport transforms, framing) lives in
 * `../lib/waterMap`. It stays mounted in the `(map)` layout beside a bottom-sheet `<Slot />`, so
 * panning/zoom survive opening a drawer.
 *
 * Data flow: the viewport bbox **and current zoom** (`onRegionDidChange`) drive `listInViewport` —
 * the zoom powers the D49 in-query prominence filter, so wide views return the few prominent bodies
 * instead of a read-capped slice. Tapping a body navigates to its `/water/[id]` drawer; the
 * highlight / fly-to focus / report photo pins come from `useMapSelection` (the drawers push them up
 * since they're siblings of this persistent map). RN has no `setFeatureState`, so the selection
 * highlight is a data-driven `filter` on dedicated layers rather than a feature-state flag.
 */
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** How long a hazard tap suppresses the water-body tap underneath it (one gesture's worth). */
const HAZARD_PRESS_PRECEDENCE_MS = 300;

/** The breathing room between the two boxes on the map's bottom rail when one has to stack. */
const RAIL_GAP = 8;

// The initial query covers the whole pilot region at the state zoom, so the map shows the prominent
// bodies (Champlain, boosted Morey) immediately — before the first `onRegionDidChange` — then each
// pan/zoom refines it. Mirrors web's regional framing (Burlington, z6.5, Phase 2.5).
const INITIAL_QUERY: { viewport: BBox; zoom: number } = {
  viewport: {
    minLng: NORTHEAST_REGION_BOUNDS[0][0],
    minLat: NORTHEAST_REGION_BOUNDS[0][1],
    maxLng: NORTHEAST_REGION_BOUNDS[1][0],
    maxLat: NORTHEAST_REGION_BOUNDS[1][1],
  },
  zoom: Math.floor(INITIAL_ZOOM),
};

/**
 * Only seed the offline body cache once zoomed in to a browse level. Below this the viewport spans a
 * whole region and would cache dozens of bodies no one is looking at; at/above it the on-screen set is
 * small and is plausibly "lakes near where I am". A floor, not a guarantee — it just bounds the writes.
 */
const CACHE_SEED_MIN_ZOOM = 11;

/**
 * A stored geometry narrowed to the two shapes a lake is ever stored as.
 *
 * `waterBodies.polygon` is typed as the whole GeoJSON geometry union because the validator accepts
 * one, but a body is a `Polygon` or a `MultiPolygon` and nothing else. Returning `null` for anything
 * else keeps the seam from being computed against a point.
 */
function polygonOf(geometry: unknown): Polygon | MultiPolygon | null {
  const type = (geometry as { type?: string } | null)?.type;
  return type === 'Polygon' || type === 'MultiPolygon'
    ? (geometry as Polygon | MultiPolygon)
    : null;
}

export default function MapView({ geolocateOnMount }: { geolocateOnMount: boolean }) {
  const scheme = useColorScheme();
  const flavor = scheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light;
  const water = WATER_PALETTE[flavor];
  const subAreaPalette = SUB_AREA_PALETTE[flavor];
  const router = useRouter();
  const cameraRef = useRef<CameraRef>(null);
  const {
    highlightWaterBodyId,
    focus,
    photoPins,
    trackPath,
    putInPin,
    pinDropMode,
    setPutInPin,
    setPinDropMode,
    drawerCoveredFraction,
    requestDrawerPeek,
    hazardDraft,
    setHazardDraft,
    hazardDraftType,
    hazardDropMode,
    setHazardDropMode,
    hazardShoreTaps,
    setHazardShoreTaps,
    browseSeason,
    contourBodyKey,
    setContourCredit,
  } = useMapSelection();
  const insets = useSafeAreaInsets();
  // The map's own height, measured — **not** the window's. The sheet's snap points are percentages of
  // the map's container, and under a tab bar that container is shorter than the window; `windowHeight`
  // therefore overstates what a 58% sheet covers by a whole tab bar, which is exactly the error this
  // pass exists to remove. The window is only the seed, for the frames before the first layout.
  const { height: windowHeight } = useWindowDimensions();
  const [mapHeight, setMapHeight] = useState(windowHeight);
  const onMapLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setMapHeight((current) => (Math.abs(current - height) > 1 ? height : current));
  }, []);
  /**
   * The imagery dock's measured height (0 when it isn't shown) — see `ImageryDock.onHeightChange`.
   * Guarded against no-op writes because the dock re-reports on every layout pass, and a state write
   * per pass would re-run the camera fit for a number that hadn't changed.
   */
  const [dockHeight, setDockHeight] = useState(0);
  const onDockHeightChange = useCallback((height: number) => {
    setDockHeight((current) => (current === height ? current : height));
  }, []);
  const hazardPalette = HAZARD_PALETTE[flavor];
  const trackColor = TRACK_PALETTE[flavor];
  const contourPalette = CONTOUR_PALETTE[flavor];
  /** When the hazard source last claimed a tap — see `onWaterPress` for why both sides check. */
  const hazardPressAtRef = useRef(0);

  // Basemap tiles: the demo archive is dated and Protomaps prunes old builds (it will 404), so it's
  // DEV-ONLY. A release build that omits EXPO_PUBLIC_PMTILES_URL must NOT silently fall back to it —
  // that ships a map destined to go blank. Instead we refuse to build a style (→ the blocking config
  // screen below), turning the misconfiguration into an immediate, obvious failure.
  const pmtilesUrl = env.pmtilesUrl || (__DEV__ ? DEMO_PMTILES_URL : '');

  // Layer-3 offline-basemap spike, route (1) (Phase 9.5) — flag-gated, off by default. When on, download
  // the regional archive once and render from the local `file://` copy so the map survives no signal.
  // Falls back to the remote URL on any failure, so this can never blank the map.
  const [localBasemapUri, setLocalBasemapUri] = useState<string | null>(null);
  useEffect(() => {
    if (!env.offlineBasemap || !pmtilesUrl) return;
    let active = true;
    void ensureOfflineBasemap(pmtilesUrl).then((uri) => {
      if (active) setLocalBasemapUri(uri);
    });
    return () => {
      active = false;
    };
  }, [pmtilesUrl]);

  const basemapSource = useMemo(
    () =>
      resolveBasemapSource({
        remoteUrl: pmtilesUrl,
        localUri: localBasemapUri,
        localReady: localBasemapUri !== null,
      }),
    [pmtilesUrl, localBasemapUri],
  );
  const mapStyle = useMemo(
    () =>
      basemapSource
        ? buildMapStyle({
            regionUrl: basemapSource,
            // Not offlined alongside the regional archive: the overview is what a skater sees when
            // they are looking at the world rather than at ice, which is exactly when they are not
            // standing on a lake with no signal. Blank simply drops the overview, never the map.
            worldUrl: env.worldPmtilesUrl || undefined,
            flavor,
          })
        : null,
    [basemapSource, flavor],
  );

  // Viewport bbox + zoom are the query key; seeded to the region so data shows before the first
  // region event, then `onRegionDidChange` refines it.
  const [queryArgs, setQueryArgs] = useState<{ viewport: BBox; zoom: number }>(INITIAL_QUERY);
  // Skipped outright once the region is off screen. Panning to Kansas cannot turn up a lake we
  // hold, so the query would be a round trip for an answer known in advance — the same reasoning
  // `subAreaArgs` applies below its zoom floor.
  const regionOffscreen = isRegionOffscreen(queryArgs.viewport);
  const bodies = useQuery(api.waterBodies.listInViewport, regionOffscreen ? 'skip' : queryArgs);
  // Named bays (N2/D60) — its own ladder-grid query. Rendering is not an operator affordance: mobile
  // draws the label, it just can't edit it (the Phase 7 rule).
  //
  // **Not subscribed below the zoom floor**: the server answers `[]` there, but that is still a
  // query execution and a subscription per viewport key, which on a phone is a round trip for an
  // answer known in advance. `SUB_AREA_MIN_RENDER_ZOOM` is shared with the server via `@skating/core`.
  const subAreaArgs = queryArgs.zoom >= SUB_AREA_MIN_RENDER_ZOOM ? queryArgs : ('skip' as const);
  const subAreas = useQuery(api.subAreas.listInViewport, subAreaArgs);

  // The lakes *this viewer* has reported as having no public access (N6f) — dimmed for them alone.
  const selfFlagged = useQuery(api.contentFlags.myAccessFlags, {});

  // Retain the last loaded features while the next query is in flight (Convex returns `undefined`
  // for a fresh key until it resolves) so bodies never blink off the map between pans.
  const [features, setFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  useEffect(() => {
    if (bodies !== undefined) {
      setFeatures(waterBodiesToFeatureCollection(bodies, new Set(selfFlagged ?? [])));
    }
  }, [bodies, selfFlagged]);
  const [subAreaFeatures, setSubAreaFeatures] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  useEffect(() => {
    // Zooming back out clears the layer rather than leaving the last bays drawn over a regional view.
    if (subAreaArgs === 'skip') setSubAreaFeatures(EMPTY_FC);
    else if (subAreas !== undefined) setSubAreaFeatures(subAreasToFeatureCollection(subAreas));
  }, [subAreas, subAreaArgs]);

  // Seed the offline body cache from what's on screen when zoomed in (Phase 9 §Mobile). Until now the
  // cache filled only when a lake's *drawer* was opened, so on-ice detection missed a lake you were
  // standing on but had never tapped. Seeding here means simply looking at your lake caches it for
  // later no-signal capture. Online, the server resolver covers this already; this is the offline
  // safety net. Bounded: only past a browse-level zoom (so we don't cache a whole region at once) and
  // deduped per session so a stationary pan doesn't rewrite the same rows.
  const seededRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (bodies === undefined || queryArgs.zoom < CACHE_SEED_MIN_ZOOM) return;
    for (const body of bodies) {
      if (seededRef.current.has(body._id)) continue;
      seededRef.current.add(body._id);
      cacheBody({
        waterBodyId: body._id,
        name: body.name,
        states: body.states,
        polygon: body.polygon as unknown as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        centroid: body.centroid,
        surfaceAreaSqM: body.surfaceAreaSqM,
      });
    }
  }, [bodies, queryArgs.zoom]);

  const photoPinsFC = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: photoPins.map((pin) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pin.coord.lng, pin.coord.lat] },
        properties: { photoId: pin.photoId },
      })),
    }),
    [photoPins],
  );

  const putInPinFC = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: putInPin
        ? [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [putInPin.lng, putInPin.lat] },
              properties: {},
            },
          ]
        : [],
    }),
    [putInPin],
  );

  // The viewer's favorited bodies (Phase 4, decision #1) — the highlight is a data-driven `in` filter
  // on a dedicated outline layer (RN has no feature-state). Empty when signed out.
  const favorites = useQuery(api.waterBodyFavorites.listForUser, {});

  // ## The freeze-up timeline (N6e §C, D148)
  //
  // Mobile has no Tier 1 aerial — that one needs a canvas React Native does not have — so here
  // "imagery" means the archive and nothing else. One toggle per lake, per D146, and it lives on the
  // map because the sheet it would otherwise sit in is a thing the map is behind.
  const [imageryOn, setImageryOn] = useState(false);
  const [freezeUpBand, setFreezeUpBand] = useState('visual');
  const [freezeUpStop, setFreezeUpStop] = useState<number | null>(null);
  /**
   * The capture date behind the current selection, so a band switch can land near where the skater
   * was rather than at the end of the season (founder, 2026-08-26). Held as a date because that is
   * what a scrubber position *is* — an index into one band's stops means nothing against another's.
   */
  const [freezeUpAnchorAt, setFreezeUpAnchorAt] = useState<string | null>(null);
  const timelineBody = useQuery(
    api.waterBodies.get,
    imageryOn && highlightWaterBodyId
      ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> }
      : 'skip',
  );
  const {
    timeline: freezeUpTimeline,
    loading: freezeUpLoading,
    season: freezeUpSeason,
    index: freezeUpIndex,
    error: freezeUpError,
  } = useFreezeUpTimeline({
    // ⚠ `available: false` is a delisting, and it must arrive as "no lake" rather than an empty one:
    // `imageryMasks` refuses to bake a mask for a delisted body, so the archive has no pixels to
    // offer and asking would be requesting frames that were never cut.
    body: timelineBody?.available ? timelineBody.body : null,
    band: freezeUpBand,
    enabled: Boolean(imageryOn && highlightWaterBodyId),
  });

  // A new lake is a new timeline; an index into the old one means nothing against the new stops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetting *because* these changed is the point.
  useEffect(() => {
    setFreezeUpStop(null);
  }, [highlightWaterBodyId, freezeUpBand]);

  // ⚠ **The picture never goes away while imagery is on** (founder, 2026-08-25). A blocked notch
  // holds the last good frame rather than clearing to bare cartography — dragging across a fortnight
  // of cloud should feel like passing over dates, not like the feature switching itself off.
  //
  // A reducer for the reason web is: the hold is state with a history, and a ref written during
  // render is not where that belongs. See {@link holdFrames}.
  const [freezeUpRendered, foldFreezeUpFrames] = useReducer(holdFrames, NO_HELD_FRAMES);
  // `imageryOn` goes through the fold for the same reason web passes it. Mobile unmounts
  // `FreezeUpFrames` with the toggle so the layers go anyway, but a hold that survives the toggle
  // would show the old picture for a frame on the way back in, and the scrubber's caption reads off
  // this too.
  useLayoutEffect(() => {
    foldFreezeUpFrames({
      bodyId: highlightWaterBodyId ?? null,
      stops: freezeUpTimeline?.stops,
      selected: freezeUpStop,
      revealing: imageryOn,
    });
  }, [highlightWaterBodyId, freezeUpTimeline, freezeUpStop, imageryOn]);
  const freezeUpSelected = freezeUpRendered.primary;

  /**
   * Choosing a stop also records **when** it was, which is the part that survives a band switch.
   *
   * Read off the timeline rather than the scrubber, because the scrubber reports an index and this
   * has to be a date — see `nearestLandableStopToDate`. Set on every selection, including the
   * automatic one, so the anchor is always the position actually on screen.
   */
  const selectFreezeUpStop = useCallback(
    (index: number) => {
      setFreezeUpStop(index);
      const at = freezeUpTimeline?.stops[index]?.frame.capturedAt;
      if (at) setFreezeUpAnchorAt(at);
    },
    [freezeUpTimeline],
  );

  // Dropping the hold on a new lake used to live here and now lives in `holdFrames`, because an
  // effect could only null the ref after the render that had already folded against it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetting *because* the lake changed is the point.
  useEffect(() => {
    // ⚠ **The anchor goes with the lake, so a new one still opens on its most recent pass.** The
    // anchor exists to survive a *band* switch, where the skater is asking the same question of a
    // different instrument. Opening a lake is a different question — "a skater asking about a lake is
    // asking about now" — and carrying February across would answer the one they did not ask.
    setFreezeUpAnchorAt(null);
    // ⚠ **Closing the lake takes the reveal with it (D146)** — web does this in `MapSelectionContext`
    // and mobile had no equivalent, because `imageryOn` is local state here. Left on, the dock
    // vanished with the lake while `FreezeUpFrames` stayed mounted against the held frames, so the
    // previous lake's photograph could sit on the map with no control anywhere to turn it off; and
    // the next lake opened with imagery already on, which is not a choice anybody made about it.
    setImageryOn(false);
  }, [highlightWaterBodyId]);

  // Where the imagery dock sits, and whether the timeline fits there at all.
  //
  // ⚠ **`drawerCoveredFraction` only updates when the sheet *settles*** (`onChange`), never during the
  // drag. That is the right trade here: a dock chasing a finger mid-drag would animate its own grow
  // against the sheet's motion, and the two would fight. It does mean the button is briefly under a
  // sheet being dragged upward, which resolves the moment it lands.
  const sheetIsClear = drawerCoveredFraction <= coveredFractionForIndex(DRAWER_PEEK);
  const sheetTop = drawerCoveredFraction * mapHeight;
  // 140 is the floor the scrubber has always used — clear of the peek on ordinary phones. On a tall
  // screen the peek is itself taller than that, so the sheet's own height wins; above the peek the
  // dock rides on the sheet's top edge (rule 1 in `ImageryDock`).
  //
  // ⚠ **And it stops climbing before it reaches the top of the map.** At the sheet's tallest detent
  // there is ~6% of screen left, and a box riding that edge would hang off the top of the map into the
  // status bar. Clamped, it slides behind the sheet instead — the honest outcome when the skater has
  // pulled the map almost entirely off screen. (`LakeSearch` used to be the other claimant up there,
  // but it scoots off the top the moment a body is selected, and the dock only exists when one is; and
  // `BackToLakeButton` now paints *under* the sheet too.)
  const railCeiling = mapHeight - 212;
  const dockBottom = Math.min(railCeiling, Math.max(140, sheetTop + 16));

  // The rail's other end (founder, 2026-08-26). "Show imagery" and "On ice" are the two things you can
  // do to the map itself, so they share one line above the sheet — imagery left, on-ice right — and
  // both ride `dockBottom`, which is what stops either from hovering over a sheet the skater has pulled
  // up. Before this, the on-ice pair was pinned at a fixed `bottom: 132/188` and simply sat on top of
  // whatever the drawer did.
  //
  // ⚠ **Only one box on the line may be wide.** A panel — the timeline, or a running on-ice session —
  // takes the full width, so when either opens the other steps *above* it rather than under it. The
  // on-ice session wins the line when both want it: it's live safety state, while the timeline is a
  // planning tool, and folding the scrubber away is a move `ImageryDock` already makes for the sheet
  // (rule 1 — the imagery layer itself stays on the map either way).
  //
  // The stack is held under the same ceiling as the rail itself, so a stacked box can't hang off the
  // top of the map either. At the tallest detent that collapses the two back onto one line — which is
  // fine, because there the whole rail is behind the sheet and there is nothing on screen to overlap.
  const [onIceExpanded, setOnIceExpanded] = useState(false);
  const imageryExpanded = imageryOn && sheetIsClear && !onIceExpanded;
  const onIceBottom =
    imageryExpanded || onIceExpanded
      ? Math.min(railCeiling, dockBottom + dockHeight + RAIL_GAP)
      : dockBottom;

  // Warm the season's frames once the timeline appears, so scrubbing does not start a cold load per
  // notch. Header ranges only — see `prefetchFrames`. Aborted when the lake or band changes, so a
  // warm cannot outlive the timeline it was for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the frame list, not its identity.
  useEffect(() => {
    const keys = freezeUpTimeline?.stops.map((s) => s.frame.key) ?? [];
    if (keys.length === 0) return;
    const controller = new AbortController();
    void prefetchFrames(env.imageryArchiveUrl, keys, controller.signal);
    return () => controller.abort();
  }, [freezeUpTimeline?.stops.length, freezeUpSeason, freezeUpBand]);
  const favoriteIds = useMemo(() => (favorites ?? []).map((f) => f.waterBodyId), [favorites]);

  // Put-in markers for the currently-focused lake (decision #7) — bounded to the open lake. `skip`
  // when nothing is selected.
  const putIns = useQuery(
    api.putIns.listForBody,
    highlightWaterBodyId ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> } : 'skip',
  );
  const putInsFC = useMemo(() => putInsToFeatureCollection(putIns ?? []), [putIns]);
  const approachesFC = useMemo(() => approachesToFeatureCollection(putIns ?? []), [putIns]);

  // Hazards + known features for the focused lake (Phase 9, D54 Layer 0). Scoped to the open body,
  // not the viewport — hazards are only ever queried per body, which is what keeps this off the
  // path `listInViewport` needed two PRs to fix before N1 bounded it. A subscribed client gets new
  // hazards live; that reactive query *is* the sync layer.
  // `browseSeason` is how the sheet's season selector reaches the layers behind it (D63): the list
  // and the pins have to belong to the same winter. Put-ins above are exempt from the reset entirely,
  // and the on-ice banner deliberately never reads this — see `HazardBanner`.
  const seasonArg = browseSeason === null ? {} : { season: browseSeason };
  const hazards = useQuery(
    api.hazards.listForBody,
    highlightWaterBodyId
      ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'>, ...seasonArg }
      : 'skip',
  );
  const bodyFeatures = useQuery(
    api.bodyFeatures.listForBody,
    highlightWaterBodyId ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'> } : 'skip',
  );
  const hazardsFC = useMemo(() => hazardsToFeatureCollection(hazards ?? []), [hazards]);
  // The aggregate tracks layer (D58) for the open lake — scoped per body like hazards, never a
  // viewport scan. A single report's own path (sheet open) wins over the lake-wide aggregate: when
  // you're reading one report, that report's line is the subject, at full strength.
  const aggregateTracks = useQuery(
    api.gpsActivities.listTracksForBody,
    highlightWaterBodyId
      ? { waterBodyId: highlightWaterBodyId as Id<'waterBodies'>, ...seasonArg }
      : 'skip',
  );
  const tracksFC = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: trackPath
        ? [{ type: 'Feature', geometry: trackPath, properties: { opacity: 1 } }]
        : (aggregateTracks?.tracks ?? []).map((t) => ({
            type: 'Feature' as const,
            geometry: t.path,
            // Server-computed from the linked report's D59 freshness — never re-derived here.
            properties: { opacity: t.opacity },
          })),
    }),
    [trackPath, aggregateTracks],
  );
  const bodyFeaturesFC = useMemo(
    () => bodyFeaturesToFeatureCollection(bodyFeatures ?? []),
    [bodyFeatures],
  );
  const hazardDraftFC = useMemo(
    () => hazardDraftToFeatureCollection(hazardDraft, hazardDraftType),
    [hazardDraft, hazardDraftType],
  );

  // ── Bathymetric contours for the open lake (N6b / D81 / D82).
  //
  // **The one source in this file that is not always mounted**, and that is the decision rather than
  // an optimisation: contours are a property of the detail view, so the source exists while a lake's
  // sheet is open and not otherwise. No toggle, no persisted preference, no settings row — the
  // visibility is derived from something the app already knows, which body is selected.
  //
  // Blank `bathymetryPmtilesUrl` ⇒ never mounted, which is correct rather than degraded: under D82
  // contours make no claim, so an unconfigured build shows a flat lake exactly as it does for the
  // majority of bodies no agency ever surveyed.
  const contourSourceRef = useRef<VectorSourceRef>(null);
  const contourCreditRef = useRef<string | null>(null);
  // The deepest ring seen for *this* lake, which only ever grows — `querySourceFeatures` answers from
  // the tiles currently loaded, so panning the deep end off screen would otherwise re-scale the ramp
  // under the skater.
  const [contourMaxDepthFt, setContourMaxDepthFt] = useState(0);
  // Whether any of this lake's lines have been read back yet, which is what holds the layer
  // invisible until they have: it fades in once its own lines are on screen, so the fade covers the
  // tile fetch rather than racing it. Popping in reads as a bug; fading in reads as a detail
  // revealing itself.
  //
  // **Separate from the depth above, deliberately.** Folding the reveal into "deepest > 0" would
  // leave a lake whose deepest drawn ring reads 0 permanently invisible while its credit row
  // rendered — a flat lake with an attribution under it.
  const [contoursRevealed, setContoursRevealed] = useState(false);
  // One query in flight at a time. The pre-reveal probe below runs per rendered frame, and without
  // this a slow tile fetch would queue a bridge round-trip for every one of them.
  const contourQueryInFlight = useRef(false);
  const contourArchiveUrl = env.bathymetryPmtilesUrl;
  const contoursMounted = Boolean(contourArchiveUrl && contourBodyKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `contourBodyKey` is the intended trigger.
  useEffect(() => {
    // A new lake starts a new ramp, a new reveal and a new credit: the last lake's deepest ring says
    // nothing about this one, and the agency that surveyed it may not be this one's.
    setContourMaxDepthFt(0);
    setContoursRevealed(false);
    contourCreditRef.current = null;
    setContourCredit(null);
  }, [contourBodyKey, setContourCredit]);

  /**
   * Read the drawn contours back off the tile — the credit and the depth ramp both come from there.
   *
   * The tile is the authority on who surveyed this lake and at what interval (§5), so the drawer's
   * credit line is derived from the features actually on screen rather than from a table keyed by
   * state.
   *
   * **Called from two events, and needing both is the finding web's half paid for.** A single
   * "everything has settled" callback (`onDidFinishRenderingMapFully`, the native analogue of web's
   * `idle`) fires before the contour tiles are fetched and is not guaranteed to come round again —
   * on web that exact design left every lake flat, invisible, with no error anywhere. So the settled
   * callback keeps the ramp growing as the skater pans, and a per-frame probe covers the reveal, and
   * that probe is unmounted the instant the first read succeeds.
   */
  async function readDrawnContours() {
    const source = contourSourceRef.current;
    if (!source || !contourBodyKey || contourQueryInFlight.current) return;
    let features: GeoJSON.Feature[];
    contourQueryInFlight.current = true;
    try {
      features = await source.querySourceFeatures({
        sourceLayer: CONTOUR_SOURCE_LAYER,
        filter: contourFilter(contourBodyKey) as FilterSpecification,
      });
    } catch {
      // The sheet closed mid-query and the source went with it. Nothing to report and nothing wrong.
      return;
    } finally {
      contourQueryInFlight.current = false;
    }
    const properties = features.map((f) => f.properties as Partial<ContourFeatureProperties>);
    // No tiles in yet, or a lake nobody surveyed. Either way keep the last answer rather than
    // clearing a credit that is still true for the lines on screen.
    if (properties.length === 0) return;

    setContoursRevealed(true);
    const line = formatContourCredit(contourCredit(properties)) || null;
    if (line !== contourCreditRef.current) {
      contourCreditRef.current = line;
      setContourCredit(line);
    }
    const deepest = maxContourDepthFt(properties);
    if (deepest !== undefined) setContourMaxDepthFt((seen) => Math.max(seen, deepest));
  }

  /**
   * Frame a drawer's focus (a lake / report put-in) into the part of the map nothing is sitting on —
   * re-fitting whenever any of those things move. A lake with `bounds` gets zoom-to-fit (`fitBounds`);
   * a bare point (a report's put-in) gets a fly at its zoom.
   *
   * ## What bounds the visible map (founder, 2026-08-26)
   *
   * > *"A selected body should be fully visible, horizontally and vertically, within the top, left and
   * > right of the screen and the top of the Freeze-up Timeline card (when the timeline card is open)
   * > or the top of the 'Show Imagery' button (when the timeline card is closed)."*
   *
   * - **Top** — the top of the *usable* screen, so `insets.top`. The map is full-bleed under the status
   *   bar, and a lake tucked behind a notch is not visible. Nothing else is reserved up here any more:
   *   `LakeSearch` scoots off the top edge whenever a body is selected, which is precisely the
   *   condition under which anything gets framed at all. That reclaimed strip is the point of this pass.
   * - **Left / right** — the screen edges. Nothing floats in the side margins.
   * - **Bottom** — the higher of two occluders, because either can be the one in the way:
   *   - the **sheet's** top edge, and
   *   - the **dock's** top edge, `dockBottom + dockHeight`, which is a *measured* height and so covers
   *     the founder's whole distinction for free — the expanded timeline card and the collapsed button
   *     are the same expression at two heights, and `dockBottom` already moves with the sheet's detent,
   *     which is why the button's top differs between the peek and the normal position.
   *
   *   Not simply the dock, because when the sheet climbs past the dock's clamp the dock slides *behind*
   *   it and the sheet becomes the taller thing again; not simply the sheet, because the dock floats
   *   above it by design. `Math.max` is the whole rule.
   *
   * `MARGIN` on every side is breathing room and nothing else — every real occluder is measured now,
   * so the margin no longer has to double as a guess about one.
   */
  useEffect(() => {
    const cam = cameraRef.current;
    if (!cam || !focus || drawerCoveredFraction <= 0 || drawerCoveredFraction >= 0.9) return;
    const MARGIN = 24;
    const padding = {
      top: insets.top + MARGIN,
      right: MARGIN,
      left: MARGIN,
      bottom: Math.max(sheetTop, dockHeight > 0 ? dockBottom + dockHeight : 0) + MARGIN,
    };
    if (focus.bounds) {
      cam.fitBounds(
        [focus.bounds.minLng, focus.bounds.minLat, focus.bounds.maxLng, focus.bounds.maxLat],
        { padding, duration: 600 },
      );
    } else {
      cam.flyTo({
        center: [focus.lng, focus.lat],
        ...(focus.zoom !== undefined ? { zoom: focus.zoom } : {}),
        padding,
        duration: 600,
      });
    }
  }, [focus, drawerCoveredFraction, sheetTop, dockBottom, dockHeight, insets.top]);

  // Home/water framing on open via device geolocation (D12/D20): a fix inside the pilot region
  // recenters there; otherwise the default Vermont framing stands. Skipped on a deep-linked drawer,
  // which frames on its own target instead (see `geolocateOnMount`).
  useEffect(() => {
    if (!geolocateOnMount) return;
    let cancelled = false;
    (async () => {
      try {
        const granted = await ensureForegroundPermission();
        if (!granted) return; // denied ⇒ keep the default framing
        const pos = await Location.getCurrentPositionAsync({});
        const frame = frameForCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (!cancelled && frame) {
          cameraRef.current?.jumpTo({ center: frame.center, zoom: frame.zoom });
        }
      } catch {
        // Location unavailable ⇒ keep the default framing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [geolocateOnMount]);

  // In pin-drop mode (§E) the next map tap sets the put-in pin; otherwise a tap on a water body
  // (handled by the source's onPress below) opens its drawer. Handlers are recreated each render, so
  // they read the current `pinDropMode` directly (no ref needed, unlike web's once-bound handler).
  function onMapPress(e: NativeSyntheticEvent<PressEvent | PressEventWithFeatures>) {
    const [lng, lat] = e.nativeEvent.lngLat;
    if (pinDropMode) {
      setPutInPin({ lat, lng });
      setPinDropMode(false);
      return;
    }
    // Snap-to-shoreline (N5b) takes the tap first: it's a two-tap affordance and the adjust bar
    // can't count them, so the map does. It never touches the draft — capture owns the body polygon
    // and turns the pair into geometry.
    //
    // **Gated on drop mode**, which web gets for free by only calling its hazard handler while armed.
    // The taps stay non-null after the band is derived (they're what the width and "Other way" controls
    // re-derive from), so without this any later tap on the map slid the pair along — dropping the
    // first end, keeping the second, and silently re-deriving the band from somewhere the skater
    // wasn't pointing at a shore.
    if (hazardDropMode && hazardShoreTaps !== null) {
      const next = [...hazardShoreTaps, { lat, lng }].slice(-2);
      setHazardShoreTaps(next);
      if (next.length === 2) setHazardDropMode(false);
      return;
    }
    // Hazard placement (Phase 9). A circle disarms on the tap that moves it; a polyline and an area
    // stay armed and take one vertex per tap, so tracing a ridge or walking the edge of a rotten
    // patch doesn't require re-arming between points.
    if (hazardDropMode && hazardDraft) {
      setHazardDraft(applyDraftMapClick(hazardDraft, { lat, lng }));
      if (hazardDraft.geometryKind === 'point_radius') setHazardDropMode(false);
    }
  }

  function onWaterPress(e: NativeSyntheticEvent<PressEventWithFeatures>) {
    if (pinDropMode || hazardDropMode) return; // a tap while placing is handled by onMapPress
    // A hazard footprint always lies *inside* a lake, so a tap on a pin hits both sources. The more
    // specific — and more safety-relevant — target has to win. Which handler RN fires first isn't
    // guaranteed, so precedence is enforced from both sides: if the hazard fired first this bails,
    // and if the water fired first the hazard's own navigate lands last and still wins.
    if (Date.now() - hazardPressAtRef.current < HAZARD_PRESS_PRECEDENCE_MS) return;
    const id = e.nativeEvent.features?.[0]?.properties?._id;
    if (typeof id === 'string') router.navigate({ pathname: '/water/[id]', params: { id } });
  }

  function onHazardPress(e: NativeSyntheticEvent<PressEventWithFeatures>) {
    if (pinDropMode || hazardDropMode) return;
    hazardPressAtRef.current = Date.now();
    const id = e.nativeEvent.features?.[0]?.properties?.hazardId;
    if (typeof id === 'string') router.navigate({ pathname: '/hazard/[id]', params: { id } });
  }

  function onRegionDidChange(e: NativeSyntheticEvent<ViewStateChangeEvent>) {
    setQueryArgs({
      viewport: boundsToViewport(e.nativeEvent.bounds),
      zoom: zoomForViewport(e.nativeEvent.zoom),
    });
  }

  // Release build with no basemap URL configured — block loudly rather than render a doomed map.
  if (!mapStyle) {
    return (
      <View style={styles.configError}>
        <Text style={styles.configErrorText}>
          Map unavailable — this build is missing its basemap configuration
          (EXPO_PUBLIC_PMTILES_URL).
        </Text>
      </View>
    );
  }

  return (
    // Wrapped so the return-to-region control can sit over the canvas. The map keeps the absolute
    // fill it always had, so nothing about the layout changes. `onLayout` measures this wrapper —
    // it is the box the sheet's snap percentages and the dock's `bottom` are both relative to, so
    // it is the only honest denominator for the camera-fit math above.
    <View style={StyleSheet.absoluteFill} onLayout={onMapLayout}>
      <MapGL
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyle}
        attribution
        logo={false}
        compass={false}
        // North is up, always — the same call as web's (see `lib/mapCanvas`), and it matters more
        // here: the two-finger twist that spins a map is the same gesture as the pinch that zooms
        // it, so on a phone it happens constantly and by accident. With `compass={false}` there is
        // nothing on screen to put it back, and a skater who has lost north on the ice has lost the
        // thing the map was for.
        touchRotate={false}
        onPress={onMapPress}
        onRegionDidChange={onRegionDidChange}
        // The settled read: the tiles for this view are in, so the ramp keeps up as the skater pans.
        onDidFinishRenderingMapFully={() => void readDrawnContours()}
        // And the reveal. Mounted only while a lake's contours are still unread, so it costs nothing
        // for the great majority of bodies-and-moments where there is nothing to wait for — see
        // `readDrawnContours` for why one settled callback is not enough to reveal a layer.
        {...(contoursMounted && !contoursRevealed
          ? { onDidFinishRenderingFrame: () => void readDrawnContours() }
          : {})}
      >
        {/* No `maxBounds`: with a whole-planet overview beneath the map there is a world worth
          looking at, so `ReturnToRegion` offers the way back instead of a fence forbidding the
          leaving (founder, 2026-08-05). */}
        <Camera ref={cameraRef} initialViewState={{ center: INITIAL_CENTER, zoom: INITIAL_ZOOM }} />

        <GeoJSONSource id="water" data={features} onPress={onWaterPress}>
          {/* The N6f access dim wraps each base opacity rather than replacing it, so the
            selected/unselected distinction survives on a dimmed lake. Shared with web through
            `withAccessDim`, which is why both signals ride the feature properties. */}
          <Layer
            id="water-fill"
            type="fill"
            paint={{ 'fill-color': water.fill, 'fill-opacity': withAccessDim(0.35) as never }}
          />
          <Layer
            id="water-fill-selected"
            type="fill"
            filter={['==', ['get', '_id'], highlightWaterBodyId ?? '']}
            paint={{ 'fill-color': water.fill, 'fill-opacity': withAccessDim(0.6) as never }}
          />
          <Layer
            id="water-outline"
            type="line"
            paint={{
              'line-color': water.outline,
              'line-width': 1,
              'line-opacity': withAccessDim(1) as never,
            }}
          />
          <Layer
            id="water-outline-selected"
            type="line"
            filter={['==', ['get', '_id'], highlightWaterBodyId ?? '']}
            paint={{
              'line-color': water.outline,
              'line-width': 2.5,
              'line-opacity': withAccessDim(1) as never,
            }}
          />
          {/* Favorited bodies read gold (Phase 4, decision #1) — a data-driven `in` filter over the
            viewer's favorite id set (matches nothing when empty / signed out). */}
          <Layer
            id="water-outline-favorite"
            type="line"
            filter={['in', ['get', '_id'], ['literal', favoriteIds]]}
            paint={{ 'line-color': FAVORITE_OUTLINE_COLOR, 'line-width': 2.5 }}
          />
        </GeoJSONSource>

        {/* Named bays, over the water fill and under every pin layer. Dashed, so it reads as a name
          for part of this lake rather than another lake's shoreline. No `onPress`: a tap falls
          through to the water source beneath and opens the parent, which is the right destination. */}
        <GeoJSONSource id="sub-areas" data={subAreaFeatures}>
          <Layer
            id="sub-area-outline"
            type="line"
            filter={['!=', ['get', 'label'], true]}
            paint={{
              'line-color': subAreaPalette.outline,
              'line-width': 1.25,
              'line-opacity': 0.8,
              'line-dasharray': [3, 2],
            }}
          />
          <Layer
            id="sub-area-label"
            type="symbol"
            filter={['==', ['get', 'label'], true]}
            layout={{
              'text-field': ['get', 'name'],
              'text-size': 12,
              // A bay name may never displace a hazard or put-in marker; if it doesn't fit, it doesn't draw.
              'text-allow-overlap': false,
              'text-optional': true,
            }}
            paint={{
              'text-color': subAreaPalette.label,
              'text-halo-color': subAreaPalette.halo,
              'text-halo-width': 1.2,
            }}
          />
        </GeoJSONSource>

        {/* ── Bathymetric contours for the open lake (N6b/D81), mounted only while its sheet is open.
          `beforeId` puts them under every pin, track and hazard that follows: contours are
          decoration and hazards are the product, so if the two ever compete for legibility the
          contour is the one that loses (D82). Hairline, and a single hue varying only in lightness —
          a green→yellow→red depth ramp would be far more legible, and that is exactly the problem. */}
        {contoursMounted ? (
          <VectorSource
            id={CONTOUR_SOURCE_ID}
            ref={contourSourceRef}
            url={contourSourceSpec(contourArchiveUrl).url}
          >
            <Layer
              id={CONTOUR_LAYER_ID}
              type="line"
              source-layer={CONTOUR_SOURCE_LAYER}
              beforeId={CONTOUR_BEFORE_LAYER_ID}
              // A guard rail, not the mechanism: a sheet can be open while the camera is zoomed out,
              // and a lake's isobaths at z6 are a smear that says nothing.
              minzoom={CONTOUR_MIN_ZOOM}
              filter={contourFilter(contourBodyKey) as FilterSpecification}
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{
                'line-color':
                  contourMaxDepthFt > 0
                    ? (contourColorExpression(contourPalette, contourMaxDepthFt) as never)
                    : contourPalette.deep,
                'line-width': contourWidthExpression() as never,
                'line-opacity': contoursRevealed ? CONTOUR_OPACITY : 0,
                'line-opacity-transition': { duration: CONTOUR_FADE_MS, delay: 0 },
              }}
            />
          </VectorSource>
        ) : null}

        <GeoJSONSource id="photo-pins" data={photoPinsFC}>
          <Layer
            id="photo-pins"
            type="circle"
            paint={{
              'circle-radius': 6,
              'circle-color': PHOTO_PIN_COLOR,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
        </GeoJSONSource>

        <GeoJSONSource id="put-in-pin" data={putInPinFC}>
          <Layer
            id="put-in-pin"
            type="circle"
            paint={{
              'circle-radius': 7,
              'circle-color': PUT_IN_PIN_COLOR,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
        </GeoJSONSource>

        {/* The walk from the car to the ice (N6e Workstream 0), drawn under the pins at its two
          ends. Built from the same markers, so a launch and its walk can never disagree about
          whether the launch is there — including when a moderator's `hide` removes it. */}
        <GeoJSONSource id={APPROACH_SOURCE_ID} data={approachesFC}>
          <Layer
            id={APPROACH_LAYER_ID}
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={approachLinePaint(APPROACH_LINE_COLOR) as never}
          />
        </GeoJSONSource>

        {/* Put-in markers for the focused lake (Phase 4, decision #7; N6d/D143 added the middle
          rung): official = accurate cyan, osm = a mapped slipway, derived = approximate muted blue.
          Three colors for three rungs of `PUTIN_SOURCES`. Distinct from the amber report-photo pins. */}
        <GeoJSONSource id="put-in-markers" data={putInsFC}>
          <Layer
            id="put-in-markers"
            type="circle"
            paint={{
              'circle-radius': 6,
              'circle-color': [
                'case',
                ['==', ['get', 'source'], 'official'],
                PUT_IN_MARKER_OFFICIAL_COLOR,
                ['==', ['get', 'source'], 'osm'],
                PUT_IN_MARKER_OSM_COLOR,
                PUT_IN_MARKER_DERIVED_COLOR,
              ],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
        </GeoJSONSource>

        {/* ── Recorded GPS tracks (Phase 8). The path someone actually skated, under the hazard layers
          so a warning is never hidden by a line. Display-only — a path can only come from a recorded
          track, so there is no draw interaction. Opacity is data-driven off the linked report's D59
          freshness, floored so an old path fades but never vanishes (a blank lake would read as
          "all clear", which we never assert). */}
        <GeoJSONSource id="tracks" data={tracksFC}>
          <Layer
            id="track-line"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{
              'line-color': trackColor,
              'line-width': 3,
              'line-opacity': ['coalesce', ['get', 'opacity'], 1] as never,
            }}
          />
        </GeoJSONSource>

        {/* ── Known seasonal body features (D53). Permanent, so no freshness ramp: a steady neutral,
          always visible, beneath the hazard pins that *do* decay. */}
        <GeoJSONSource id="body-features" data={bodyFeaturesFC}>
          <Layer
            id="body-feature-fill"
            type="fill"
            paint={{ 'fill-color': hazardPalette.feature, 'fill-opacity': 0.22 }}
          />
          <Layer
            id="body-feature-outline"
            type="line"
            paint={{
              'line-color': hazardPalette.feature,
              'line-width': 1.5,
              'line-dasharray': [4, 2],
            }}
          />
        </GeoJSONSource>

        {/* ── Hazards (Phase 9). Drawn as buffered *footprint* polygons, not markers, so the shape on
          screen is literally the shape the proximity evaluator measures against. Soft fill + a dashed
          outline while provisional: a hazard is "reported around here", never a surveyed boundary. */}
        <GeoJSONSource id="hazards" data={hazardsFC} onPress={onHazardPress}>
          <Layer
            id="hazard-fill"
            type="fill"
            paint={{
              'fill-color': hazardColorExpression(hazardPalette) as never,
              'fill-opacity': hazardFillOpacityExpression() as never,
            }}
          />
          {/* Dashed while provisional (one unverified report), solid once independently confirmed —
            the same soft/hard distinction the on-ice banner makes (D54). **Two layers, not one
            expression:** `line-dasharray` takes no data expression, and the native renderer says so
            out loud ("line-dasharray data expressions not supported") before dropping the property.
            The filters partition the source, so every hazard is still drawn exactly once. */}
          <Layer
            id="hazard-outline-provisional"
            type="line"
            filter={PROVISIONAL_HAZARD_FILTER as never}
            paint={{
              'line-color': hazardColorExpression(hazardPalette) as never,
              'line-width': 1.5,
              'line-dasharray': [...PROVISIONAL_DASH_ARRAY],
            }}
          />
          <Layer
            id="hazard-outline-confirmed"
            type="line"
            filter={CONFIRMED_HAZARD_FILTER as never}
            paint={{
              'line-color': hazardColorExpression(hazardPalette) as never,
              'line-width': 1.5,
            }}
          />
        </GeoJSONSource>

        {/* The hazard being captured — the real metric footprint, updated live as vertices land and
          the size changes, so what you see while placing is what gets stored. */}
        <GeoJSONSource id="hazard-draft" data={hazardDraftFC}>
          <Layer
            id="hazard-draft-fill"
            type="fill"
            paint={{
              'fill-color': hazardColorExpression(hazardPalette) as never,
              'fill-opacity': 0.35,
            }}
          />
          <Layer
            id="hazard-draft-outline"
            type="line"
            paint={{ 'line-color': hazardColorExpression(hazardPalette) as never, 'line-width': 2 }}
          />
          {/* The tapped vertices. A one-vertex line has no honest footprint yet, so without these the
            first tap of a trace would land with no feedback at all. */}
          <Layer
            id="hazard-draft-vertices"
            type="circle"
            filter={['==', ['get', 'role'], 'vertex']}
            paint={{
              'circle-radius': 6,
              'circle-color': hazardColorExpression(hazardPalette) as never,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
        </GeoJSONSource>

        {imageryOn ? (
          <FreezeUpFrames
            stop={freezeUpSelected}
            companion={freezeUpRendered.companion?.frame ?? null}
            season={freezeUpSeason}
            body={polygonOf(timelineBody?.available ? timelineBody.body.polygon : null)}
          />
        ) : null}
      </MapGL>
      {/* One control per lake (D146), on the map rather than in the sheet — the sheet is the thing
          the map is behind, so a control for the map cannot live inside it. Toggle and timeline are
          the same box now (founder, 2026-08-25); `ImageryDock` holds the reasoning.

          `imageryArchiveUrl` gates the scrubber and nothing else. With no archive configured there is
          nothing to scrub and nothing true to say about why, so the correct render is none at all —
          the same call the bathymetry layer makes when its own URL is blank. */}
      <ImageryDock
        visible={Boolean(highlightWaterBodyId) && !hazardDraft}
        imageryOn={imageryOn}
        expanded={imageryExpanded}
        // No archive ⇒ no scrubber ⇒ nothing for a heading to head, which is the same gate the
        // children below are behind.
        heading={env.imageryArchiveUrl ? 'Freeze-up timeline' : null}
        // Web fills this slot from the aerial when no archived frame is on the lake. Mobile has no
        // aerial layer to fall back to, so the honest answer there is nothing at all.
        seasonLabel={
          freezeUpSelected && freezeUpTimeline ? formatSeasonLabel(freezeUpTimeline.season) : null
        }
        bottom={dockBottom}
        // Feeds the camera fit above: the lake is framed to end where this box starts.
        onHeightChange={onDockHeightChange}
        onPress={() => {
          // Both halves of the founder's rule, in the order they have to happen: ask the sheet down,
          // then turn imagery on. Pressing this while imagery is *already* on is the "bring the
          // timeline back" case — nothing to switch, only the sheet is in the way.
          if (!sheetIsClear) requestDrawerPeek();
          setImageryOn(true);
        }}
        onClose={() => setImageryOn(false)}
      >
        {env.imageryArchiveUrl ? (
          <FreezeUpScrubber
            timeline={freezeUpTimeline}
            index={freezeUpIndex}
            band={freezeUpBand}
            onBandChange={setFreezeUpBand}
            selected={freezeUpStop}
            onSelect={selectFreezeUpStop}
            anchorAt={freezeUpAnchorAt}
            loading={freezeUpLoading}
            error={freezeUpError}
            renderedCompanion={freezeUpRendered.companion?.frame ?? null}
          />
        ) : null}
      </ImageryDock>

      {/* The rail's right-hand end: going out on the ice, in one control (founder, 2026-08-26). It
          lives here rather than in the `(map)` layout precisely so it paints *under* the sheet like
          the imagery dock does — the pair of buttons it replaces sat above the sheet at a fixed
          height and covered whatever the skater had opened. */}
      <OnIceDock bottom={onIceBottom} onExpandedChange={setOnIceExpanded} />

      <ReturnToRegion
        visible={regionOffscreen}
        onReturn={() =>
          cameraRef.current?.flyTo({
            center: INITIAL_CENTER,
            zoom: INITIAL_ZOOM,
            duration: 900,
          })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  configError: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#1c1c1e',
  },
  configErrorText: { color: '#ffffff', textAlign: 'center', fontSize: 15, lineHeight: 22 },
});
