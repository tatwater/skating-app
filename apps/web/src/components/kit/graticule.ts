/**
 * The graticule's arithmetic: which parallels and meridians a map pane shows, and where their
 * labels may sit. Pure — the pane hands in its size and two projections, so the same numbers hold
 * under MapLibre, a story's still, or a test.
 *
 * The rules are the boards' (Review 11 #5, Review 12 #4, Review 13 #5):
 * - **True parallels and meridians**, at a round step — hundredths of a degree on a lake, coarser
 *   farther out — chosen so parallels stand at least `minSpacing` px apart.
 * - **Labeled at the edges**: latitudes at the right edge just over their line (`43.66°N`),
 *   longitudes along the bottom just right of their line (`72.20°W`), the longitude row running the
 *   map's full width over whatever foot the pane has.
 * - **Only on clear ground**: a label that would touch a keep-out (the layer rack, the dock, a mode
 *   bar — anything the pane says is UI) is left out, never moved.
 */

export interface Point {
  x: number;
  y: number;
}

/** A box in pane px. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GraticuleInput {
  /** The pane's size, px. */
  width: number;
  height: number;
  /** A geographic point to pane px. */
  project: (lngLat: readonly [number, number]) => Point;
  /** Pane px to a geographic point. */
  unproject: (point: Point) => { lng: number; lat: number };
  /** The least gap between parallels, px (the boards' 34). */
  minSpacing?: number;
  /** The least gap between two longitude labels' starts, px (the boards' 66). */
  minLabelSpacing?: number;
  /** Room kept clear at the pane's foot (a map key's bar), px. The longitude row sits over it. */
  footInset?: number;
  /** Boxes no label may touch. */
  keepouts?: readonly Rect[];
}

export interface GraticuleLabel {
  /** Where the text's anchor sits: its start (a longitude) or its end (a latitude). */
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'end';
}

export interface GraticuleLayout {
  step: number;
  /** Each meridian's x and each parallel's y, px. */
  meridians: number[];
  parallels: number[];
  labels: GraticuleLabel[];
}

/** The round steps, in degrees, finest first. */
export const GRATICULE_STEPS = [
  0.0005, 0.001, 0.002, 0.0025, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10,
] as const;

/** A label's box, px: the mono label at the kicker step is about this wide and tall. */
export const LABEL_WIDTH = 58;
export const LABEL_HEIGHT = 12;
/** A longitude label sits this far right of its meridian, and this far up from the row's floor. */
const LNG_DX = 4;
const LNG_DY = 7;
/** A latitude label ends this far in from the right edge, and sits this far over its parallel. */
const LAT_DX = 6;
const LAT_DY = 4;
/** Labels keep this far from a keep-out. */
const CLEAR = 6;
/** No latitude label this close to the top edge, or into the longitude row. */
const LAT_TOP = 18;
const LAT_FOOT = 22;

/** Decimals a step needs to read without rounding (0.01 → 2, 0.0025 → 4, 1 → 0). */
export function stepDecimals(step: number): number {
  for (let d = 0; d <= 6; d++) {
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
  }
  return 6;
}

/** `43.66°N`, `0.50°S`. */
export function formatLatitude(lat: number, decimals: number): string {
  return `${Math.abs(lat).toFixed(decimals)}°${lat < 0 ? 'S' : 'N'}`;
}

/** `72.20°W`, `3.00°E`. */
export function formatLongitude(lng: number, decimals: number): string {
  return `${Math.abs(lng).toFixed(decimals)}°${lng < 0 ? 'W' : 'E'}`;
}

/** The finest step whose parallels stand at least `minSpacing` px apart. */
export function graticuleStep(pxPerDegreeLat: number, minSpacing = 34): number {
  return GRATICULE_STEPS.find((s) => s * pxPerDegreeLat >= minSpacing) ?? 10;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Multiples of `step` from `from` to `to`, computed as integers so 0.1 + 0.2 never drifts. */
function multiples(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(from / step - 1e-9);
  const last = Math.floor(to / step + 1e-9);
  for (let i = first; i <= last; i++) out.push(Number((i * step).toFixed(10)));
  return out;
}

/** The pane's graticule: its step, its lines, and the labels that fit on clear ground. */
export function graticuleLayout(input: GraticuleInput): GraticuleLayout {
  const {
    width,
    height,
    project,
    unproject,
    minSpacing = 34,
    minLabelSpacing = 66,
    footInset = 0,
    keepouts = [],
  } = input;
  const empty = { step: 0, meridians: [], parallels: [], labels: [] };
  if (width <= 0 || height <= 0) return empty;
  const nw = unproject({ x: 0, y: 0 });
  const se = unproject({ x: width, y: height });
  const spanLat = nw.lat - se.lat;
  const spanLng = se.lng - nw.lng;
  if (!(spanLat > 0) || !(spanLng > 0)) return empty;

  const step = graticuleStep(height / spanLat, minSpacing);
  const decimals = stepDecimals(step);
  const midLat = (nw.lat + se.lat) / 2;
  const midLng = (nw.lng + se.lng) / 2;

  const lngs = multiples(nw.lng, se.lng, step);
  const lats = multiples(se.lat, nw.lat, step);
  const meridians = lngs.map((g) => project([g, midLat]).x);
  const parallels = lats.map((g) => project([midLng, g]).y);

  const clear = (box: Rect) =>
    !keepouts.some((k) =>
      overlaps(box, {
        left: k.left - CLEAR,
        top: k.top - CLEAR,
        right: k.right + CLEAR,
        bottom: k.bottom + CLEAR,
      }),
    );

  const labels: GraticuleLabel[] = [];
  // Longitudes: along the foot, thinned so their starts stand `minLabelSpacing` apart.
  const pxPerStep = lngs.length > 1 ? Math.abs((meridians[1] ?? 0) - (meridians[0] ?? 0)) : width;
  const every = Math.max(1, Math.ceil(minLabelSpacing / Math.max(pxPerStep, 1)));
  const rowY = height - footInset - LNG_DY;
  lngs.forEach((g, i) => {
    const x = meridians[i] ?? 0;
    // Thinned on the global index, so a pan doesn't make labels hop between meridians.
    if (Math.round(g / step) % every !== 0) return;
    const box = {
      left: x + LNG_DX,
      top: rowY - LABEL_HEIGHT + 2,
      right: x + LNG_DX + LABEL_WIDTH,
      bottom: rowY + 2,
    };
    if (x <= 8 || box.right > width - 4 || !clear(box)) return;
    labels.push({ x: x + LNG_DX, y: rowY, text: formatLongitude(g, decimals), anchor: 'start' });
  });
  // Latitudes: at the right edge, just over their parallel, out of the top edge and the foot row.
  lats.forEach((g, i) => {
    const y = parallels[i] ?? 0;
    const ty = y - LAT_DY;
    if (y <= LAT_TOP || y >= height - footInset - LAT_FOOT) return;
    const box = {
      left: width - LAT_DX - LABEL_WIDTH,
      top: ty - LABEL_HEIGHT + 2,
      right: width,
      bottom: ty + 2,
    };
    if (!clear(box)) return;
    labels.push({ x: width - LAT_DX, y: ty, text: formatLatitude(g, decimals), anchor: 'end' });
  });

  return { step, meridians, parallels, labels };
}
