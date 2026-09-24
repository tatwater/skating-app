import type { LatLng } from '@skating/core';

/**
 * What the report console hands the hazard form when a photo *is* the hazard (A10-7, photo →
 * hazard): the photo's location as the pin, and the photo itself as the first attachment. A
 * module-level note rather than a search param, because a `File` cannot ride a URL and the form
 * mounts on the lake's drawer, a route away. Read once, on the form's mount, and cleared.
 */
export interface HazardPrefill {
  coord?: LatLng;
  files: File[];
}

let pending: HazardPrefill | null = null;

export function setHazardPrefill(prefill: HazardPrefill | null): void {
  pending = prefill;
}

/** Take the pending prefill, leaving none — a form mounts once and must not re-consume it. */
export function takeHazardPrefill(): HazardPrefill | null {
  const taken = pending;
  pending = null;
  return taken;
}
