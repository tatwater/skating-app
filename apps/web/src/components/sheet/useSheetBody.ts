import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  type FeedCardData,
  type HazardType,
  type LatLng,
  type PassableHazard,
  type SectorFrame,
  type SilhouetteData,
  type SunTimes,
  sectorFrame,
  silhouetteRings,
  sunTimes,
} from '@skating/core';
import { useQuery } from 'convex/react';
import type { MultiPolygon, Polygon } from 'geojson';
import { useEffect, useMemo } from 'react';
import { recordBodyOutline } from '../../lib/bodyOutlines';

/** A known launch or lot, as the picker and the map want it. */
export interface SheetAccessPoint {
  id: string;
  coord: LatLng;
  name: string;
  kind: 'putIn' | 'parking';
}

/** A live hazard on the body, as the tick-through wants it. */
export interface SheetHazard extends PassableHazard {
  createdByUserId?: string;
  label: string;
}

export interface SheetBody {
  waterBodyId: string;
  name: string;
  polygon: Polygon | MultiPolygon | null;
  /** The outline for the map, with the wedge apex — `null` until the polygon is known. */
  silhouette: SilhouetteData | null;
  frame: SectorFrame | null;
  bays: { id: string; name: string }[];
  putIns: SheetAccessPoint[];
  parking: SheetAccessPoint[];
  hazards: SheetHazard[];
  /** The body's recent cards — the peer lines' input (§4.4). */
  recentCards: FeedCardData[];
  /** Civil sunrise/sunset at the body for `atMs`, for the end-time row's daylight gate (D192). */
  sunAt: (atMs: number) => SunTimes | null;
  /** The viewer's zone. A desk is not the lake, but it is the zone the author reads times in. */
  timeZone: string;
}

/**
 * Everything one Report panel needs of its body: the outline, the bays, the launches and lots, the
 * live hazards, the recent cards. The web twin of mobile's `useSheetBody` — same shape, from the
 * same queries, minus the offline caches a browser has no equivalent of. A body-less sheet (a Post
 * whose lake has not been picked yet) gets `null`.
 */
export function useSheetBody(waterBodyId: string | undefined): SheetBody | null {
  const skip = waterBodyId === undefined;
  const bodyResult = useQuery(
    api.waterBodies.get,
    skip ? 'skip' : { waterBodyId: waterBodyId as Id<'waterBodies'> },
  );
  const bays = useQuery(
    api.subAreas.listForBody,
    skip ? 'skip' : { waterBodyId: waterBodyId as Id<'waterBodies'> },
  );
  const access = useQuery(
    api.accessPoints.accessForBody,
    skip ? 'skip' : { waterBodyId: waterBodyId as Id<'waterBodies'> },
  );
  const hazardRows = useQuery(
    api.hazards.listForBody,
    skip ? 'skip' : { waterBodyId: waterBodyId as Id<'waterBodies'> },
  );
  const recent = useQuery(
    api.reports.recentCardsForBodies,
    skip ? 'skip' : { waterBodyIds: [waterBodyId as Id<'waterBodies'>] },
  );
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const result = useMemo<SheetBody | null>(() => {
    if (waterBodyId === undefined) return null;
    const body = bodyResult?.available ? bodyResult.body : null;
    const polygon = (body?.polygon as unknown as Polygon | MultiPolygon | undefined) ?? null;
    const interior = (body?.interiorPoint ?? undefined) as LatLng | undefined;
    const frame = polygon ? sectorFrame(polygon, interior) : null;
    const silhouette: SilhouetteData | null =
      polygon && frame
        ? { ...silhouetteRings(polygon), origin: frame.origin, middleRadiusM: frame.middleRadiusM }
        : null;
    const anchor = frame?.origin ?? (body?.centroid as LatLng | undefined);
    const hazards: SheetHazard[] = (hazardRows ?? [])
      .filter((h) => h.status === 'active')
      .map((h) => ({
        id: h._id,
        type: h.type as HazardType,
        shape: {
          geometryKind: h.geometryKind,
          geometry: h.geometry as PassableHazard['shape']['geometry'],
          ...(h.radiusMeters !== undefined ? { radiusMeters: h.radiusMeters } : {}),
          ...(h.bufferMeters !== undefined ? { bufferMeters: h.bufferMeters } : {}),
        },
        ...(h.clippedFootprint !== undefined
          ? { clippedFootprint: h.clippedFootprint as PassableHazard['clippedFootprint'] }
          : {}),
        bbox: h.bbox,
        ...(h.createdByUserId !== undefined ? { createdByUserId: h.createdByUserId } : {}),
        label: h.type.replace(/_/g, ' '),
      }));
    return {
      waterBodyId,
      name: body?.name ?? '',
      polygon,
      silhouette,
      frame,
      bays: (bays ?? []).filter((b) => !b.removed).map((b) => ({ id: b._id, name: b.name })),
      putIns: (access?.putIns ?? []).map((p) => ({
        id: p.id,
        coord: p.coord,
        name: p.name ?? 'Launch',
        kind: 'putIn' as const,
      })),
      parking: (access?.parking ?? []).map((lot) => ({
        id: lot.id,
        coord: lot.coord,
        name: lot.name ?? 'Parking',
        kind: 'parking' as const,
      })),
      hazards,
      recentCards: recent ?? [],
      sunAt: (atMs) => (anchor ? sunTimes(atMs, anchor.lat, anchor.lng, timeZone) : null),
      timeZone,
    };
  }, [waterBodyId, bodyResult, bays, access, hazardRows, recent, timeZone]);
  // The outline, for the photo pool's location rules (A10-7): recorded the moment it lands.
  const polygon = result?.polygon ?? null;
  useEffect(() => {
    if (waterBodyId !== undefined && polygon !== null) recordBodyOutline(waterBodyId, polygon);
  }, [waterBodyId, polygon]);
  return result;
}
