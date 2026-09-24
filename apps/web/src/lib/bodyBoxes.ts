import type { BBox } from '@skating/core';
import { useSyncExternalStore } from 'react';

/**
 * The bounding box of every lake the console has drawn (A10-7): what assigns a photo by its
 * location to a Report whose tab is not the active one. `useSheetBody` records a box the moment a
 * lake's geometry arrives; the pool re-runs its rules when one does. A module store, keyed by the
 * water body id, because the boxes outlive any one tab.
 */
const boxes: Record<string, BBox> = {};
const listeners = new Set<() => void>();
let snapshot: Readonly<Record<string, BBox>> = boxes;

export function recordBodyBox(waterBodyId: string, bbox: BBox): void {
  const prior = boxes[waterBodyId];
  if (
    prior &&
    prior.minLat === bbox.minLat &&
    prior.maxLat === bbox.maxLat &&
    prior.minLng === bbox.minLng &&
    prior.maxLng === bbox.maxLng
  )
    return;
  boxes[waterBodyId] = bbox;
  snapshot = { ...boxes };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const get = () => snapshot;

/** Every recorded box, by lake. */
export function useBodyBoxes(): Readonly<Record<string, BBox>> {
  return useSyncExternalStore(subscribe, get, get);
}

/** Test seam. */
export function resetBodyBoxesForTests(): void {
  for (const k of Object.keys(boxes)) delete boxes[k];
  snapshot = { ...boxes };
}
