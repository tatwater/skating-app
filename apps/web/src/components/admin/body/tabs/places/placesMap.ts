/**
 * What the Places tab asks the frame's map to draw — plain data, no map library. The frame builder
 * owns the real descriptor types; these are the narrow ones this tab needs, so reconciling is
 * mechanical.
 *
 * Places draws every live landmark as its kind's mark, each skater's proposal as a dashed `?`
 * (faded back, with its key), the selected landmark lit (its plate pinned, every other mark faded)
 * and the hovered one hovered (a row's hover is its marker's).
 */
import type { LandmarkKind } from '@skating/core';

export type LatLng = { lat: number; lng: number };

export type PlacesMapPoint =
  | {
      id: string;
      mark: 'landmark';
      kind: LandmarkKind;
      at: LatLng;
      label: string;
      /** The plate's slug when lit: the list's word and its catalogs ("TOWN · OSM · GNIS"). */
      slug: string;
      lit: boolean;
      hovered: boolean;
    }
  | {
      id: string;
      mark: 'proposal';
      at: LatLng;
      label: string;
      lit: boolean;
      hovered: boolean;
    };

export type PlacesMapKeyEntry = { mark: 'proposal'; label: string };

export type PlacesMapDrawing = {
  points: PlacesMapPoint[];
  key: PlacesMapKeyEntry[];
  /** The lit item's id, when it is on the map. */
  lit: string | null;
  /** The hovered item's id, when it is on the map. */
  hovered: string | null;
};
