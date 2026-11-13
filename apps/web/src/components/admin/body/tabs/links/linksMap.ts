import { linkCoordinate, type ReferenceLinkBody } from '@skating/core';

import { type BodyMapScene, EMPTY_SCENE, type MapPoint } from '../../map/mapDescriptors';
import { coordWords } from './linksModel';

/**
 * What the Links tab asks the frame's map to draw (board 5.4.9): the one point Windy and
 * Copernicus open on — the interior point, derived from the outline, stored nowhere, not movable —
 * plated as on Water and lit, so every other mark steps back while its plate shows; the plate
 * wears a last line (`caption`) under the coordinate.
 */

/** The interior point's address: the same `?lit=` the plate answers to. */
export const INTERIOR_POINT_ID = 'interior:point';

export function linksMapScene(body: ReferenceLinkBody | null, _lit: string | null): BodyMapScene {
  const c = body === null ? undefined : linkCoordinate(body);
  if (c === undefined) return EMPTY_SCENE;
  const point: MapPoint = {
    kind: 'point',
    id: INTERIOR_POINT_ID,
    layer: 'samples',
    at: [c.lng, c.lat],
    mark: 'sample',
    hoverKicker: 'Interior point',
    name: coordWords(c),
    caption: 'Windy and Copernicus open here',
  };
  // Links lights nothing else: the plate always shows.
  return { items: [point], lit: INTERIOR_POINT_ID };
}
