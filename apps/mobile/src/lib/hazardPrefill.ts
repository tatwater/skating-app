import type { DraftPhoto, LatLng } from '@skating/core';

/**
 * What the report sheet hands the map's hazard capture when a photo *is* the hazard (A10-7, photo
 * → hazard): the photo's location as the pin, and the photo as the first attachment — its files
 * **already copied** into the capture's own storage, because the capture frees what it holds on
 * Cancel and the hazard queue frees it after a flush, and the sheet's copy must outlive both.
 *
 * A module-level note, as on web, rather than a field on the map context: the sheet renders on the
 * Report tab, outside any `MapSelectionProvider`, and the map's provider is another instance
 * anyway. The capture takes it once, on the nonce the ask rides with, and it is cleared.
 */
export interface HazardPrefill {
  coord?: LatLng;
  photos: DraftPhoto[];
  /** The sheet photos `photos` were copied from — attached on arrival, so never suggested too. */
  sourceIds: string[];
}

let pending: HazardPrefill | null = null;

export function setHazardPrefill(prefill: HazardPrefill | null): void {
  pending = prefill;
}

/** Take the pending prefill, leaving none — one ask, one read. */
export function takeHazardPrefill(): HazardPrefill | null {
  const taken = pending;
  pending = null;
  return taken;
}
