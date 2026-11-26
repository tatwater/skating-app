/**
 * **The quarter-quad grid and the archive's tile grid** for the summer aerial (B05 §2.2, D317).
 *
 * A NAIP key like `4407236se` is a 3.75′ cell: the 1° block at 44°N 72°W, the 7.5′ quad 36 of 64,
 * quadrant SE. Its nominal outline is exact from the key, so the grid is computed, never read.
 *
 * **Zooms are pixel zooms** (D317 is worded in pixel terms): the zoom a 256-px tile would carry at
 * that resolution, so z18 is 0.43 m a pixel at 44°N. The archive's tiles are 512 px (Governor fork
 * G-2), so a tile's own number in the archive is the pixel zoom minus one — `naipTileZoom`. The
 * work tile is a cell of the slippy grid, which is the same ground whatever the tile size.
 *
 * The seven states' envelopes live here too (`NAIP_STATE_ENVELOPES`): the rule's geometric drop of a
 * mislabeled item (§2.1.1) and `quarterQuadsIn`'s bound are the same geography.
 */

import type { BBox } from './geometry';
import type { NaipState } from './naipSelection';

/** The zoom of the unit of work: one z11 slippy tile per Machine job (§2.2). */
export const NAIP_WORK_ZOOM = 11;
/** The archive's shallowest pixel zoom; below it the aerial draws nothing (§2.3). */
export const NAIP_MIN_ZOOM = 8;
/** The archive's deepest pixel zoom, everywhere (D317): 0.43 m a pixel at 44°N. */
export const NAIP_MAX_ZOOM = 18;
/** The archive's tile edge in pixels (G-2): a quarter of the requests 256-px tiles would need. */
export const NAIP_TILE_SIZE = 512;

/**
 * A pixel zoom's tile number in the archive: `z − log2(NAIP_TILE_SIZE / 256)`. So the archive's
 * header reads 7–17, a shard holds tile zooms 11–17 (the work tile itself down to the deepest level)
 * and the assembler builds 7–10 from the shards' z11 tiles.
 */
export function naipTileZoom(pixelZoom: number): number {
  return pixelZoom - Math.log2(NAIP_TILE_SIZE / 256);
}

/** One work tile: a slippy tile at `NAIP_WORK_ZOOM`. */
export interface WorkTile {
  z: number;
  x: number;
  y: number;
}

/** A work tile's stable name, `11/<x>/<y>`: the manifest's key for it and its shard's path. */
export function workTileKey(tile: WorkTile): string {
  if (tile.z !== NAIP_WORK_ZOOM) {
    throw new Error(`a work tile is at z${NAIP_WORK_ZOOM}, not z${tile.z}`);
  }
  const span = 2 ** NAIP_WORK_ZOOM;
  for (const [axis, n] of [
    ['x', tile.x],
    ['y', tile.y],
  ] as const) {
    if (!Number.isInteger(n) || n < 0 || n >= span) {
      throw new Error(`work tile ${axis} ${n} is not a z${NAIP_WORK_ZOOM} tile index`);
    }
  }
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** The inverse of `workTileKey`; throws on anything it wouldn't have written. */
export function parseWorkTileKey(key: string): WorkTile {
  const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (!match) throw new Error(`not a work tile key: ${key}`);
  const tile = { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
  if (workTileKey(tile) !== key) throw new Error(`not a work tile key: ${key}`);
  return tile;
}

// ── The quarter-quad grid ─────────────────────────────────────────────────────────────────────────
//
// Everything below works in **sixteenths of a degree** — the quarter-quad's edge, 3.75′ = 1/16° —
// so the grid's arithmetic is on integers and exact: a cell's edges are `i / 16`, which a double
// holds exactly, and a point's cell is `floor(16 · coord)`, where multiplying by 16 is exact too.
// Nothing here rounds, so no point can land in two cells or none.

/** Quarter-quads per degree, each way. */
const PER_DEGREE = 16;

const KEY = /^(\d{2})(\d{3})(\d{2})(n|s)(e|w)$/;

/** A quarter-quad key, read: its south-west corner as sixteenths of a degree (`lng16` negative). */
interface CellIndex {
  /** `16 · south`. */
  lat16: number;
  /** `16 · west` (negative: the grid is west longitudes). */
  lng16: number;
}

/**
 * Reads `4407236se`: the 1° block whose south-east corner is 44°N 72°W, the 7.5′ quad 36 of its 64
 * (numbered from the block's north-west corner, west to east, then row by row southward), quadrant
 * SE. Throws on anything else, including a quad outside 1–64.
 */
function readKey(key: string): CellIndex {
  const match = KEY.exec(key);
  if (!match) throw new Error(`not a quarter-quad key: ${JSON.stringify(key)}`);
  const [, lat, lng, quad, ns, ew] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const q = Number(quad);
  if (q < 1 || q > 64) throw new Error(`quarter-quad key ${key}: quad ${q} is not 1–64`);
  const row = Math.floor((q - 1) / 8); // 0 = the block's northern row
  const col = (q - 1) % 8; // 0 = the block's western column
  return {
    lat16: Number(lat) * PER_DEGREE + (7 - row) * 2 + (ns === 'n' ? 1 : 0),
    lng16: -(Number(lng) + 1) * PER_DEGREE + col * 2 + (ew === 'e' ? 1 : 0),
  };
}

/** The inverse of `readKey`. Only the grid's own domain has keys: north and west, |lng| < 1000. */
function writeKey(lat16: number, lng16: number): string {
  const latDeg = Math.floor(lat16 / PER_DEGREE);
  const westDeg = Math.floor(lng16 / PER_DEGREE); // the block's west edge, e.g. -73 for 72°W
  if (latDeg < 0 || latDeg > 99 || westDeg >= 0 || westDeg < -1000) {
    throw new Error(`no quarter-quad key at ${lat16 / PER_DEGREE}, ${lng16 / PER_DEGREE}`);
  }
  const inLat = lat16 - latDeg * PER_DEGREE; // 0–15, from the block's south edge
  const inLng = lng16 - westDeg * PER_DEGREE; // 0–15, from the block's west edge
  const row = 7 - Math.floor(inLat / 2);
  const col = Math.floor(inLng / 2);
  const quad = row * 8 + col + 1;
  return (
    String(latDeg).padStart(2, '0') +
    String(-westDeg - 1).padStart(3, '0') +
    String(quad).padStart(2, '0') +
    (inLat % 2 === 1 ? 'n' : 's') +
    (inLng % 2 === 1 ? 'e' : 'w')
  );
}

/** Is `key` shaped like a quarter-quad key with a real quad number? */
export function isQuarterQuadKey(key: string): boolean {
  try {
    readKey(key);
    return true;
  } catch {
    return false;
  }
}

/** A quarter-quad's nominal outline (NAD83, read as WGS84), exact from its key. */
export function quarterQuadCell(key: string): BBox {
  const { lat16, lng16 } = readKey(key);
  return {
    minLat: lat16 / PER_DEGREE,
    minLng: lng16 / PER_DEGREE,
    maxLat: (lat16 + 1) / PER_DEGREE,
    maxLng: (lng16 + 1) / PER_DEGREE,
  };
}

/**
 * The key of the quarter-quad containing a point. Cells are closed on their south and west edges
 * and open on their north and east, so a point on an edge belongs to exactly one cell. Throws for a
 * point the grid doesn't name (south of the equator, east of Greenwich).
 */
export function quarterQuadAt(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`no quarter-quad at ${lat}, ${lng}`);
  }
  return writeKey(Math.floor(lat * PER_DEGREE), Math.floor(lng * PER_DEGREE));
}

// ── The seven states' envelopes ───────────────────────────────────────────────────────────────────

/**
 * Each state's extent, to the arc-minute, rounded outward (the states' published latitude and
 * longitude ranges). The rule drops an item whose quarter-quad lies outside its labeled state's
 * envelope grown by `NAIP_ENVELOPE_MARGIN` (§2.1.1) — a geometric test, never one by name.
 *
 * Measured against the scouts' 69,207-item catalog: no state's real flights reach more than 0.25′
 * past its envelope (Vermont's, at its Québec corner), and the 744 mislabeled `me_` items sit at
 * least 1.75′ outside Maine's (their northern edge is 42°56.25′; Maine starts at 42°58′). The margin
 * sits between the two.
 */
export const NAIP_STATE_ENVELOPES: Readonly<Record<NaipState, BBox>> = {
  NY: arcMinutes(40, 30, 45, 1, 79, 46, 71, 51),
  VT: arcMinutes(42, 44, 45, 1, 73, 26, 71, 28),
  NH: arcMinutes(42, 42, 45, 18, 72, 33, 70, 36),
  ME: arcMinutes(42, 58, 47, 28, 71, 5, 66, 57),
  MA: arcMinutes(41, 14, 42, 53, 73, 30, 69, 56),
  CT: arcMinutes(40, 58, 42, 3, 73, 44, 71, 47),
  RI: arcMinutes(41, 9, 42, 1, 71, 53, 71, 7),
};

/** How far past its envelope a state's frame may lie and still be the state's: 1′ (~1.8 km). */
export const NAIP_ENVELOPE_MARGIN = 1 / 60;

/** South, north (°N) and west, east (°W), each as degrees and minutes. */
function arcMinutes(
  sD: number,
  sM: number,
  nD: number,
  nM: number,
  wD: number,
  wM: number,
  eD: number,
  eM: number,
): BBox {
  return {
    minLat: sD + sM / 60,
    maxLat: nD + nM / 60,
    minLng: -(wD + wM / 60),
    maxLng: -(eD + eM / 60),
  };
}

/**
 * Does the quarter-quad `key` share area with `state`'s envelope grown by the margin? A cell that
 * only touches the grown envelope's edge does not.
 */
export function quarterQuadInState(key: string, state: NaipState): boolean {
  const cell = quarterQuadCell(key);
  const env = NAIP_STATE_ENVELOPES[state];
  const m = NAIP_ENVELOPE_MARGIN;
  return (
    cell.minLat < env.maxLat + m &&
    cell.maxLat > env.minLat - m &&
    cell.minLng < env.maxLng + m &&
    cell.maxLng > env.minLng - m
  );
}

/**
 * The region the archive can hold: every state's envelope grown by the margin, out to whole
 * quarter-quads. No key outside it can ever be in a date index.
 */
export const NAIP_REGION: BBox = (() => {
  const envs = Object.values(NAIP_STATE_ENVELOPES);
  const m = NAIP_ENVELOPE_MARGIN;
  const out = (v: number) => Math.floor(v * PER_DEGREE) / PER_DEGREE;
  const up = (v: number) => Math.ceil(v * PER_DEGREE) / PER_DEGREE;
  return {
    minLat: out(Math.min(...envs.map((e) => e.minLat)) - m),
    minLng: out(Math.min(...envs.map((e) => e.minLng)) - m),
    maxLat: up(Math.max(...envs.map((e) => e.maxLat)) + m),
    maxLng: up(Math.max(...envs.map((e) => e.maxLng)) + m),
  };
})();

/**
 * Every quarter-quad key the bounds touch, sorted — the cells under a map view (§4.2). Any point in
 * the bounds and inside `NAIP_REGION` has its key in the set (an edge point's cell, per
 * `quarterQuadAt`, included); outside the region nothing is listed, since no index can hold a key
 * there — which also bounds the loop, whatever view the map hands in (~3,100 keys at the console's
 * z8 floor; at most ~29,000 for a view of the whole region). Empty for bounds that miss the region.
 */
export function quarterQuadsIn(bounds: BBox): string[] {
  const minLat = Math.max(bounds.minLat, NAIP_REGION.minLat);
  const minLng = Math.max(bounds.minLng, NAIP_REGION.minLng);
  // The region is half-open like a cell: its north and east edges belong to no cell inside it.
  const maxLat = Math.min(bounds.maxLat, NAIP_REGION.maxLat - 1e-9);
  const maxLng = Math.min(bounds.maxLng, NAIP_REGION.maxLng - 1e-9);
  if (!(minLat <= maxLat && minLng <= maxLng)) return [];
  const keys: string[] = [];
  const lat0 = Math.floor(minLat * PER_DEGREE);
  const lat1 = Math.floor(maxLat * PER_DEGREE);
  const lng0 = Math.floor(minLng * PER_DEGREE);
  const lng1 = Math.floor(maxLng * PER_DEGREE);
  for (let y = lat0; y <= lat1; y++) {
    for (let x = lng0; x <= lng1; x++) keys.push(writeKey(y, x));
  }
  return keys.sort();
}

// ── Work tiles ────────────────────────────────────────────────────────────────────────────────────

/**
 * The work tiles a quarter-quad's outline touches, sorted by `workTileKey`. A cell edge lying on a
 * tile edge touches only the tile on the cell's side: the x span is computed on integers (a z11
 * tile is 45/256° wide and a cell 16/256°, so their edges meet every 2.8125°), so no float can tip
 * a cell into a neighbor it only abuts.
 */
export function workTilesOf(key: string): WorkTile[] {
  const { lat16, lng16 } = readKey(key);
  const span = 2 ** NAIP_WORK_ZOOM;
  // x = (lng + 180) / 360 · 2^z = (16·lng + 2880) · 2^z / 5760, and 2^11 / 5760 = 16 / 45.
  const w = (lng16 + 180 * PER_DEGREE) * 16;
  const e = (lng16 + 1 + 180 * PER_DEGREE) * 16;
  const x0 = Math.floor(w / 45);
  const x1 = Math.ceil(e / 45) - 1;
  const y0 = Math.floor(mercatorY((lat16 + 1) / PER_DEGREE) * span);
  const y1 = Math.ceil(mercatorY(lat16 / PER_DEGREE) * span) - 1;
  const tiles: WorkTile[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) tiles.push({ z: NAIP_WORK_ZOOM, x, y });
  }
  // Distinct tiles, so the order needs no tie.
  return tiles.sort((a, b) => (workTileKey(a) < workTileKey(b) ? -1 : 1));
}

/** Web Mercator's y in 0–1 (north at 0) for a latitude. */
function mercatorY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
