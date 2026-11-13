import { linkCoordinate, type ReferenceLinkBody } from '@skating/core';

import { coordWords } from './linksModel';

/**
 * What the Links tab asks the frame's map to draw (board 5.4.9): the one point Windy and Copernicus
 * open on — the interior point, derived from the outline, stored nowhere, not movable — marked and
 * plated as on Water, with every other mark stepped back while its plate shows.
 *
 * Plain data. The frame owns the real descriptor types; these are this tab's narrow copy, so
 * reconciling them is mechanical.
 */

/** `[lng, lat]`, GeoJSON order. */
export type LngLat = readonly [number, number];

export type LinksMapItem = {
  kind: 'point';
  id: 'interior-point';
  at: LngLat;
  /** The plate's slug. */
  label: 'Interior point';
  /** The plate's figure: the coordinate. */
  value: string;
  /** The plate's last line: why the point is here. */
  caption: string;
};

export type LinksMapDraw = {
  items: LinksMapItem[];
  /** The item whose plate shows. */
  lit: LinksMapItem['id'] | null;
  /** Every mark not in `items` steps back while the plate shows. */
  fadeOthers: boolean;
};

export function linksMapDraw(body: ReferenceLinkBody): LinksMapDraw {
  const c = linkCoordinate(body);
  if (c === undefined) return { items: [], lit: null, fadeOthers: false };
  return {
    items: [
      {
        kind: 'point',
        id: 'interior-point',
        at: [c.lng, c.lat],
        label: 'Interior point',
        value: coordWords(c),
        caption: 'Windy and Copernicus open here',
      },
    ],
    lit: 'interior-point',
    fadeOthers: true,
  };
}
