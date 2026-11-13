/**
 * What the Water tab asks the frame's map to draw — plain data, no map library. The frame builder
 * owns the real descriptor types; these are the narrow ones this tab needs.
 *
 * Water draws where the weather is sampled — the interior point (or the points set by hand), the
 * point's plate pinned with what happens there — and the body's box as a survey's dimension lines,
 * since the box is what decides whether one point is enough.
 */

export type LatLng = { lat: number; lng: number };

export type WaterMapPoint = {
  id: string;
  mark: 'sample-point';
  at: LatLng;
  /** The plate's slug ("Interior point") and what happens there ("Weather samples here"). */
  label: string;
  caption: string;
  lit: boolean;
};

/** The body's box with its two spans, drawn as dimension lines. */
export type WaterMapBox = {
  id: 'bbox';
  box: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  /** "4.9 KM", east–west then north–south. */
  ew: string;
  ns: string;
};

export type WaterMapDrawing = {
  points: WaterMapPoint[];
  boxes: WaterMapBox[];
  lit: string | null;
};
