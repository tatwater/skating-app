/**
 * A known feature's glyph (board 5.4.7's Known features rows): its own footprint as a few square
 * cells, brightest deepest inside, thinning to the edge — the dot field's drawing, small, where a
 * hazard row has its clock. Pure.
 */

type Area = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** The glyph's grid: at most this many cells across its longer side. */
export const GLYPH_CELLS = 9;

/** The field's four levels (the mock's `LEVELS`): reported here → its possible extent. */
export const FIELD_LEVELS = [1, 0.66, 0.42, 0.24] as const;

const M_PER_DEG = 111_320;

/** Rings in local meters (east, north), equirectangular about the area's mean latitude. */
function ringsOf(area: Area): [number, number][][] {
  const polys = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
  const lats = polys.flatMap((p) => p.flatMap((r) => r.map((c) => c[1] as number)));
  const lat0 = lats.reduce((a, b) => a + b, 0) / Math.max(1, lats.length);
  const k = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG;
  return polys.flatMap((p) =>
    p.map((r) =>
      r.map((c) => [(c[0] as number) * k, (c[1] as number) * M_PER_DEG] as [number, number]),
    ),
  );
}

function inside(p: [number, number], rings: readonly [number, number][][]): boolean {
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i] as [number, number];
      const [xj, yj] = r[j] as [number, number];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function toEdge(p: [number, number], rings: readonly [number, number][][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const r of rings) {
    for (let i = 1; i < r.length; i++) {
      const [ax, ay] = r[i - 1] as [number, number];
      const [bx, by] = r[i] as [number, number];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)),
      );
      best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
    }
  }
  return best;
}

/** A cell of the glyph: its column, row (north up) and level. */
export type GlyphCell = { col: number; row: number; level: number };

/** The glyph: the cells inside the footprint, each at one of `FIELD_LEVELS`; `cols × rows` cells. */
export function featureGlyph(area: Area): { cols: number; rows: number; cells: GlyphCell[] } {
  const rings = ringsOf(area);
  const xs = rings.flatMap((r) => r.map((c) => c[0]));
  const ys = rings.flatMap((r) => r.map((c) => c[1]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const size = Math.max(x1 - x0, y1 - y0) / GLYPH_CELLS || 1;
  const cols = Math.max(1, Math.min(GLYPH_CELLS, Math.ceil((x1 - x0) / size)));
  const rows = Math.max(1, Math.min(GLYPH_CELLS, Math.ceil((y1 - y0) / size)));
  const found: { col: number; row: number; d: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const p: [number, number] = [x0 + (col + 0.5) * size, y1 - (row + 0.5) * size];
      if (inside(p, rings)) found.push({ col, row, d: toEdge(p, rings) });
    }
  }
  const deepest = Math.max(0, ...found.map((f) => f.d));
  const cells = found.map(({ col, row, d }) => {
    const depth = deepest === 0 ? 1 : d / deepest;
    const level =
      depth > 0.75
        ? FIELD_LEVELS[0]
        : depth > 0.5
          ? FIELD_LEVELS[1]
          : depth > 0.25
            ? FIELD_LEVELS[2]
            : FIELD_LEVELS[3];
    return { col, row, level };
  });
  return { cols, rows, cells };
}
