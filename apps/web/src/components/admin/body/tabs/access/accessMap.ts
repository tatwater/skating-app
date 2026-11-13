/**
 * What the Access tab asks the frame's map to draw — plain data, no map library. The frame builder
 * owns the real descriptor types; these are the narrow ones this tab needs.
 *
 * Access draws the put-ins (official and mapped), the lots, and each routed walk from a lot to its
 * put-in as a line; the lit item (a put-in or a lot) is marked.
 */

export type LatLng = { lat: number; lng: number };

export type AccessMapPoint =
  | {
      id: string;
      mark: 'put-in';
      /** Who vouches for it: an operator's pin, a mapped launch, or the reports. */
      source: 'official' | 'osm' | 'derived';
      at: LatLng;
      label: string;
      lit: boolean;
    }
  | { id: string; mark: 'lot'; at: LatLng; label: string | null; lit: boolean };

/** A walk from a lot to its put-in, as routed. */
export type AccessMapLine = { id: string; style: 'approach'; path: LatLng[]; lit: boolean };

export type AccessMapDrawing = {
  points: AccessMapPoint[];
  lines: AccessMapLine[];
  /** The lit item's id, when it is on the map. */
  lit: string | null;
};
