/**
 * What the Standing tab asks the frame's map to draw: nothing of its own. Its board's one hover
 * plate (a GNIS town) demonstrates the page's own marks, which are the frame's.
 *
 * The frame owns the real descriptor types; this tab's list is empty, so its item type is `never`.
 */
export type StandingMapItem = never;

export function standingMapItems(): StandingMapItem[] {
  return [];
}
