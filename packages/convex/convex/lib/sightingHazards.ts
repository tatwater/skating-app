/**
 * The hazard pins a Report's located sightings imply (D210), written with the Report.
 *
 * `sightingHazardShape` (core) decides the shape; this reads what it needs — the body's outline and
 * only the bays the sightings name, so the read is bounded by the Report — and writes through
 * `insertHazard` + `tryAutoMerge`, the path every in-report hazard takes, with the Report as
 * provenance. A derived pin the author already drew (same type, footprints touching) is skipped:
 * the drawn one is the more precise claim, and two pins for one open lead is the state auto-merge
 * exists to remove. Create derives from every sighting; an edit only from the sightings it adds,
 * since a pin already filed has its own lifecycle (confirmations, decay) that an edit must not
 * restart.
 */

import {
  describeSighting,
  type HazardShape,
  hazardFootprint,
  type LocatedSighting,
  polygonDistanceMeters,
  sightingHazardShape,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { HAZARD_MAX_PER_REPORT, insertHazard } from '../hazards';
import { tryAutoMerge } from './hazardMerge';

type DrawnHazard = { type: Doc<'hazards'>['type']; shape: HazardShape };

export function drawnHazardOf(h: {
  type: Doc<'hazards'>['type'];
  geometryKind: Doc<'hazards'>['geometryKind'];
  geometry: unknown;
  radiusMeters?: number;
  bufferMeters?: number;
}): DrawnHazard {
  return {
    type: h.type,
    shape: {
      geometryKind: h.geometryKind,
      geometry: h.geometry as HazardShape['geometry'],
      ...(h.radiusMeters !== undefined ? { radiusMeters: h.radiusMeters } : {}),
      ...(h.bufferMeters !== undefined ? { bufferMeters: h.bufferMeters } : {}),
    },
  };
}

/** Did the author already draw this — the same type, footprints touching? */
function alreadyDrawn(derived: DrawnHazard, drawn: readonly DrawnHazard[]): boolean {
  const footprint = hazardFootprint(derived.shape);
  return drawn.some(
    (d) =>
      d.type === derived.type && polygonDistanceMeters(hazardFootprint(d.shape), footprint) === 0,
  );
}

/** The sightings an edit adds — the ones the stored row did not already say, where and all. */
export function addedSightings(
  before: readonly LocatedSighting[] | undefined,
  after: readonly LocatedSighting[] | undefined,
): LocatedSighting[] {
  const had = new Set((before ?? []).map((s) => JSON.stringify([s.type, s.where ?? null])));
  return (after ?? []).filter((s) => !had.has(JSON.stringify([s.type, s.where ?? null])));
}

/**
 * Write the pins `sightings` imply on `body`, skipping any the author drew; returns the surviving
 * hazard ids (after auto-merge, deduped). At most `budget` new pins — the per-report hazard cap
 * bounds the write fan-out here as it does for drawn ones.
 */
export async function deriveSightingHazards(
  ctx: MutationCtx,
  args: {
    body: Doc<'waterBodies'>;
    sightings: readonly LocatedSighting[];
    drawn: readonly DrawnHazard[];
    authorId: Id<'profiles'>;
    reportId: Id<'reports'>;
    now: number;
    budget?: number;
  },
): Promise<Id<'hazards'>[]> {
  const { body } = args;
  if (body.polygon.type !== 'Polygon' && body.polygon.type !== 'MultiPolygon') return [];
  const budget = Math.max(0, args.budget ?? HAZARD_MAX_PER_REPORT);
  const bays: Record<string, Polygon | MultiPolygon> = {};
  const bayNames: Record<string, string> = {};
  for (const id of new Set(
    args.sightings.flatMap((s) => (s.where?.subAreaId ? [s.where.subAreaId] : [])),
  )) {
    const bay = await ctx.db.get(id as Id<'waterBodySubAreas'>);
    if (!bay || bay.waterBodyId !== body._id) continue;
    bays[id] = bay.polygon as unknown as Polygon | MultiPolygon;
    bayNames[id] = bay.name;
  }
  // A landmark chosen by name sits on its label point — land, often — so its point pins nothing
  // (D202); the core rule tells a chosen landmark from a tap by that point.
  const landmarkPoints: Record<string, { lat: number; lng: number }> = {};
  for (const id of new Set(
    args.sightings.flatMap((s) => (s.where?.point?.landmarkId ? [s.where.point.landmarkId] : [])),
  )) {
    const normalized = ctx.db.normalizeId('bodyLandmarks', id);
    const landmark = normalized ? await ctx.db.get(normalized) : null;
    if (landmark && landmark.waterBodyId === body._id) landmarkPoints[id] = landmark.point;
  }
  const geometry = {
    outline: body.polygon as unknown as Polygon | MultiPolygon,
    ...(body.interiorPoint ? { interiorPoint: body.interiorPoint } : {}),
    bays,
    landmarkPoints,
  };
  const out: Id<'hazards'>[] = [];
  let written = 0;
  for (const sighting of args.sightings) {
    if (written >= budget) break;
    const derived = sightingHazardShape(sighting, geometry);
    if (!derived || alreadyDrawn(derived, args.drawn)) continue;
    const hazardId = await insertHazard(
      ctx,
      {
        waterBodyId: body._id,
        type: derived.type,
        geometryKind: derived.shape.geometryKind,
        geometry: derived.shape.geometry,
        ...(derived.shape.radiusMeters !== undefined
          ? { radiusMeters: derived.shape.radiusMeters }
          : {}),
        description: `Seen, not skated: ${describeSighting(sighting, bayNames)}`,
      },
      args.authorId,
      args.now,
      args.reportId,
    );
    written++;
    const { survivorId } = await tryAutoMerge(ctx, hazardId);
    if (!out.includes(survivorId)) out.push(survivorId);
  }
  return out;
}
