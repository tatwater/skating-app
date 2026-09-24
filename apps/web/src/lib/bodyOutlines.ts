import { polygonBBox } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { useSyncExternalStore } from 'react';

type Outline = Polygon | MultiPolygon;

/**
 * The outline of every lake the console has drawn (A10-7): what assigns a photo by its location to
 * a Report whose tab is not the active one (by the outline's box), and what places it by itself
 * (only on the water, `onWater`). `useSheetBody` records an outline the moment a lake's geometry
 * arrives; the pool re-runs its rules when one does. A module store, keyed by the water body id,
 * because the outlines outlive any one tab.
 */
const outlines: Record<string, Outline> = {};
const listeners = new Set<() => void>();
let snapshot: Readonly<Record<string, Outline>> = outlines;

/** Cheap enough to take per record, and a re-fetch of the same lake is not a new outline. */
function sameOutline(a: Outline, b: Outline): boolean {
  if (a === b) return true;
  const ba = polygonBBox(a);
  const bb = polygonBBox(b);
  const count = (o: Outline) =>
    (o.type === 'Polygon' ? o.coordinates : o.coordinates.flat(1)).reduce(
      (n, r) => n + r.length,
      0,
    );
  return (
    ba.minLat === bb.minLat &&
    ba.maxLat === bb.maxLat &&
    ba.minLng === bb.minLng &&
    ba.maxLng === bb.maxLng &&
    count(a) === count(b)
  );
}

export function recordBodyOutline(waterBodyId: string, outline: Outline): void {
  const prior = outlines[waterBodyId];
  if (prior && sameOutline(prior, outline)) return;
  outlines[waterBodyId] = outline;
  snapshot = { ...outlines };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const get = () => snapshot;

/** Every recorded outline, by lake. */
export function useBodyOutlines(): Readonly<Record<string, Outline>> {
  return useSyncExternalStore(subscribe, get, get);
}

/** Test seam. */
export function resetBodyOutlinesForTests(): void {
  for (const k of Object.keys(outlines)) delete outlines[k];
  snapshot = { ...outlines };
}
