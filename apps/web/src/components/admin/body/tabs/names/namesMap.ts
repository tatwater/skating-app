/**
 * What the Names tab asks the frame's map to draw — plain data, no map library. The frame builder
 * owns the real descriptor types; these are the narrow ones this tab needs, kept plain (ids,
 * coordinates, kinds, labels) so reconciling them is mechanical.
 *
 * Names draws the town lines that cross the body (Census TIGER county subdivisions), each with the
 * two towns it divides named on either side, faded back so the water leads, and the line's key.
 */

export type LatLng = { lat: number; lng: number };

/** A boundary line and the two towns facing each other across it (left, then right of its run). */
export type NamesMapLine = {
  id: string;
  style: 'town-line';
  path: LatLng[];
  /** The town on the run's left (north or west), then the one on its right. */
  faces: [string, string];
  lit: boolean;
};

/** A key entry at the map's foot: the mark, its noun, and the catalog that vouches for it. */
export type NamesMapKeyEntry = { mark: 'town-line'; label: string; tag: string };

export type NamesMapDrawing = {
  lines: NamesMapLine[];
  key: NamesMapKeyEntry[];
  /** The lit item's id, if it is on the map. */
  lit: string | null;
};
