import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  approachesToFeatureCollection,
  type BBox,
  type DriveTimeBands,
  hasWeatherFilter,
  isRegionOffscreen,
  landmarkLabelFeatures,
  mapFilters,
  SUB_AREA_MIN_RENDER_ZOOM,
  weatherDimmedBodyIds,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { useFeedFilters } from '@/lib/feedFiltersStore';
import { bodyFeaturesToFeatureCollection, hazardsToFeatureCollection } from '@/lib/hazardMap';
import { subAreasToFeatureCollection, waterBodiesToFeatureCollection } from '@/lib/waterMap';
import type { PutInMarkModel } from './MapMarksLayer';
import {
  bountyCountsByBody,
  buildLakeLabels,
  hazardMarksFrom,
  type LabelableBody,
  labelCountIds,
  mergeHazards,
  reportCountsByBody,
  withBayAngles,
} from './mapDerive';
import { EMPTY_FEATURES } from './mapLayers';
import type { MapSpec } from './mapSpec';

/**
 * Every read the map makes, and what it derives from them. **Every read is skipped while the pane
 * is hidden**, so a page with no map (Settings, a profile) holds no map subscriptions; and the
 * viewport read is skipped once the region is off screen, where it can't find anything (D49, A01).
 *
 * The per-lake reads (put-ins, places, hazards, features, tracks) follow the spec's focus — never
 * the viewport — which is what keeps them off the read path that's been fixed for cost twice.
 */

export interface ViewportQuery {
  viewport: BBox;
  zoom: number;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** The last defined value, so a re-keyed subscription doesn't blink the map between pans. */
function useRetained<T>(value: T | undefined, reset: boolean): T | undefined {
  const [held, setHeld] = useState<T | undefined>(value);
  useEffect(() => {
    if (reset) setHeld(undefined);
    else if (value !== undefined) setHeld(value);
  }, [value, reset]);
  return reset ? undefined : (value ?? held);
}

export function useSkaterMapData({
  query,
  spec,
  now,
}: {
  query: ViewportQuery | null;
  spec: MapSpec;
  now: number;
}) {
  const visible = spec.visible;
  const focusId = (spec.focus?.bodyId ?? null) as Id<'waterBodies'> | null;
  const offscreen = query ? isRegionOffscreen(query.viewport) : false;
  const viewportArgs = visible && query && !offscreen ? query : 'skip';

  const bodiesNow = useQuery(api.waterBodies.listInViewport, viewportArgs);
  const bodies = useRetained(bodiesNow, viewportArgs === 'skip');

  const selfFlagged = useQuery(api.contentFlags.myAccessFlags, visible ? {} : 'skip');
  const favorites = useQuery(api.waterBodyFavorites.listForUser, visible ? {} : 'skip');
  const favoriteKey = favorites?.map((f) => f.waterBodyId).join(',') ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content, not identity.
  const favoriteIds = useMemo(
    () => new Set<string>((favorites ?? []).map((f) => f.waterBodyId)),
    [favoriteKey],
  );

  // The weather discovery dim (A06h / D166): the same saved filters the feed uses.
  const { value: feedFilters } = useFeedFilters();
  const discoveryKey = JSON.stringify(mapFilters(feedFilters));
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content.
  const discovery = useMemo(() => mapFilters(feedFilters), [discoveryKey]);
  const weatherOn = visible && hasWeatherFilter(discovery);
  const matchedCells = useQuery(
    api.weatherDiscovery.matchedCells,
    weatherOn ? { filters: discovery } : 'skip',
  );
  const viewer = useQuery(api.profiles.current, weatherOn ? {} : 'skip');
  const weatherDimmed = useMemo(() => {
    if (!weatherOn || !bodies) return NO_IDS;
    return weatherDimmedBodyIds(bodies, discovery, matchedCells, {
      bands: {
        band30: viewer?.cachedIsochrones?.band30,
        band60: viewer?.cachedIsochrones?.band60,
        outerRadiusMeters: viewer?.outerRadiusMeters,
      } as DriveTimeBands,
      home: viewer?.homeCoord,
      favorites: favoriteIds,
    });
  }, [weatherOn, bodies, discovery, matchedCells, viewer, favoriteIds]);

  const selfFlaggedKey = (selfFlagged ?? []).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content.
  const selfFlaggedIds = useMemo(() => new Set<string>(selfFlagged ?? []), [selfFlaggedKey]);
  const dimmedIds = useMemo(
    () => new Set<string>([...weatherDimmed, ...selfFlaggedIds]),
    [weatherDimmed, selfFlaggedIds],
  );

  const water = useMemo(
    () =>
      bodies
        ? waterBodiesToFeatureCollection(bodies, selfFlaggedIds, weatherDimmed)
        : EMPTY_FEATURES,
    [bodies, selfFlaggedIds, weatherDimmed],
  );

  // Bays: their own grid query, and not subscribed at all below the zoom they draw at.
  const subAreaArgs =
    visible && query && !offscreen && query.zoom >= SUB_AREA_MIN_RENDER_ZOOM ? query : 'skip';
  const subAreasNow = useQuery(api.subAreas.listInViewport, subAreaArgs);
  const subAreas = useRetained(subAreasNow, subAreaArgs === 'skip');
  const subAreaFeatures = useMemo(
    () => (subAreas ? withBayAngles(subAreasToFeatureCollection(subAreas)) : EMPTY_FEATURES),
    [subAreas],
  );

  // The focused lake.
  const focusArgs = visible && focusId ? { waterBodyId: focusId } : 'skip';
  const focusRead = useQuery(api.waterBodies.get, focusArgs);
  // A merged body reads as its survivor; a removed one reads as unavailable, and frames nothing.
  const focusBody = focusRead?.available ? focusRead.body : undefined;
  const putIns = useQuery(api.putIns.listForBody, focusArgs);
  const landmarks = useQuery(api.landmarks.listForBody, focusArgs);
  const hazards = useQuery(api.hazards.listForBody, focusArgs);
  const bodyFeatures = useQuery(api.bodyFeatures.listForBody, focusArgs);
  const tracks = useQuery(
    api.gpsActivities.listTracksForBody,
    visible && focusId && spec.layers.tracks ? { waterBodyId: focusId } : 'skip',
  );

  // Every lake in view draws its hazards, not just the open one (D3): the viewport read, bounded by
  // its scan cap and keyed on the same settled viewport as the lakes.
  const viewportHazardsNow = useQuery(
    api.hazards.listInViewport,
    viewportArgs === 'skip' ? 'skip' : { viewport: viewportArgs.viewport },
  );
  const viewportHazards = useRetained(viewportHazardsNow, viewportArgs === 'skip');
  const focusBodyId = focusBody?._id;
  const hazardFeatures = useMemo(() => {
    const focusIds = new Set<string>([focusId, focusBodyId].filter((id) => id != null));
    const rows = mergeHazards(focusId ? hazards : undefined, viewportHazards?.hazards, focusIds);
    return rows.length > 0 ? hazardsToFeatureCollection(rows) : EMPTY_FEATURES;
  }, [focusId, focusBodyId, hazards, viewportHazards]);
  const hazardMarks = useMemo(() => hazardMarksFrom(hazardFeatures), [hazardFeatures]);
  const approachFeatures = useMemo(() => approachesToFeatureCollection(putIns ?? []), [putIns]);
  const putInMarks = useMemo<PutInMarkModel[]>(
    () =>
      (focusId ? (putIns ?? []) : []).map((p, i) => ({
        id: `${i}:${p.coord.lat},${p.coord.lng}`,
        lng: p.coord.lng,
        lat: p.coord.lat,
        ...(p.name ? { name: p.name } : {}),
      })),
    [focusId, putIns],
  );
  const landmarkFeatures = useMemo(
    () => (focusId && landmarks ? landmarkLabelFeatures(landmarks, putIns ?? []) : EMPTY_FEATURES),
    [focusId, landmarks, putIns],
  );
  const bodyFeatureFeatures = useMemo(
    () => (focusId ? bodyFeaturesToFeatureCollection(bodyFeatures ?? []) : EMPTY_FEATURES),
    [focusId, bodyFeatures],
  );
  const trackFeatures = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: (focusId ? (tracks?.tracks ?? []) : []).map((t) => ({
        type: 'Feature' as const,
        geometry: t.path,
        // The server's D59 freshness; the map never re-derives decay.
        properties: { opacity: t.opacity },
      })),
    }),
    [focusId, tracks],
  );

  // Labels: open bounties across the viewport (a small, bounded set), and the report counts for the
  // labeled bodies only — the cap is what bounds that read.
  const bountiesNow = useQuery(
    api.bounties.listOpen,
    visible && query && !offscreen && spec.layers.labels ? { viewport: query.viewport } : 'skip',
  );
  const bounties = useRetained(bountiesNow, viewportArgs === 'skip');
  const bountyCounts = useMemo(() => bountyCountsByBody(bounties), [bounties]);
  const labelsOn = spec.layers.labels;
  const showFavorites = spec.layers.favorites;
  const labelBodies = useMemo(() => (bodies ?? []) as unknown as LabelableBody[], [bodies]);
  const labelInputs = useMemo(
    () => ({ favoriteIds, bountyCounts, dimmedIds, focusId, showFavorites }),
    [favoriteIds, bountyCounts, dimmedIds, focusId, showFavorites],
  );
  const countKey = labelsOn ? labelCountIds(labelBodies, labelInputs).join(',') : '';
  const countArgs = useMemo(
    () =>
      visible && countKey !== ''
        ? { waterBodyIds: countKey.split(',') as Id<'waterBodies'>[] }
        : ('skip' as const),
    [visible, countKey],
  );
  // The slim, viewer-free count (D13): every viewer panning over the same lakes shares one answer.
  const counts = useQuery(api.reports.recentCountsForBodies, countArgs);
  // Held with the ids it answered, so a re-keyed read keeps the counts it has without lending them
  // to bodies it never asked about.
  const answered = useRetained(
    useMemo(
      () => (counts === undefined ? undefined : { key: countKey, counts }),
      [counts, countKey],
    ),
    countArgs === 'skip',
  );
  const reportCounts = useMemo(
    () => (answered ? reportCountsByBody(answered.counts, answered.key.split(',')) : undefined),
    [answered],
  );

  const timeZone = viewer?.timezone ?? undefined;
  const labels = useMemo(
    () =>
      labelsOn ? buildLakeLabels(labelBodies, { ...labelInputs, reportCounts, now, timeZone }) : [],
    [labelsOn, labelBodies, labelInputs, reportCounts, now, timeZone],
  );

  return {
    bodies,
    offscreen,
    water,
    subAreaFeatures,
    focusBody,
    hazardFeatures,
    hazardMarks,
    approachFeatures,
    putInMarks,
    landmarkFeatures,
    bodyFeatureFeatures,
    trackFeatures,
    labels,
  };
}
