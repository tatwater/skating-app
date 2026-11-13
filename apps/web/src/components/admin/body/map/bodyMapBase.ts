import { type LandmarkKind, pointInPolygon, representativePoint } from '@skating/core';
import { PLACE_KEY_LABELS } from './kit-candidates/place-marks';
import type { BodyMapScene, LngLat, MapItem } from './mapDescriptors';

/**
 * The frame's own scene: what the console map draws whichever tab is open — the body's outline,
 * its bays (each named along its basin), its named places, its put-ins and lots, its weather sample
 * points. Every item is addressed the way `?lit=` addresses it (`body:`, `bay:`, `landmark:`,
 * `putIn:`, `lot:`, `sample:`), so a tab that lights a row lights its thing on the map too.
 */

type Coord = { lat: number; lng: number };

export interface BodyMapBaseInput {
  bodyId: string;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  bays: readonly {
    id: string;
    name: string;
    polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    /** A chord bay's stored mouth: drawn as the line where the bay begins. */
    mouth?: { a: Coord; b: Coord } | null;
  }[];
  landmarks: readonly {
    id: string;
    name: string;
    kind: LandmarkKind;
    point: Coord;
    /** The catalog that vouches for it, for the hover plate ("Island · OSM"). */
    source?: string;
  }[];
  putIns: readonly { id: string; coord: Coord; name?: string }[];
  lots: readonly { id: string; coord: Coord; name?: string }[];
  samplePoints: readonly Coord[];
}

const at = (c: Coord): LngLat => [c.lng, c.lat];

/** The outer rings' vertices of a polygon or multipolygon. */
function outerVertices(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): GeoJSON.Position[] {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.flatMap((p) => p[0] ?? []);
}

/**
 * Where a bay's name goes and the angle it runs at: the middle of its water, along its long axis
 * (the boards run *MASCOMA NORTH* down its basin). The axis is the vertices' principal component in
 * a local, cos-φ-scaled frame; the angle is screen degrees clockwise from east, turned to read
 * left to right (−90° to 90°). The center is the vertices' mean when that is on the water, else a
 * point the polygon guarantees is.
 */
export function basinLabel(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): {
  at: LngLat;
  angle: number;
} {
  const pts = outerVertices(geom);
  const n = pts.length || 1;
  const mx = pts.reduce((s, p) => s + (p[0] ?? 0), 0) / n;
  const my = pts.reduce((s, p) => s + (p[1] ?? 0), 0) / n;
  const cos = Math.cos((my * Math.PI) / 180);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    // Screen axes: x east, y down.
    const x = ((p[0] ?? 0) - mx) * cos;
    const y = -((p[1] ?? 0) - my);
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  // Half of atan2's (−180°, 180°] is (−90°, 90°]: the axis already reads left to right.
  const angle = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
  const mean = { lat: my, lng: mx };
  const center = pointInPolygon(mean, geom) ? mean : representativePoint(geom);
  return { at: at(center), angle: Number(angle.toFixed(1)) };
}

/** The frame's scene for one body. */
export function bodyMapBase(input: BodyMapBaseInput): BodyMapScene {
  const items: MapItem[] = [
    {
      kind: 'outline',
      id: `body:${input.bodyId}`,
      layer: 'outline',
      geometry: input.polygon,
      style: 'body',
    },
  ];
  for (const bay of input.bays) {
    items.push({
      kind: 'outline',
      id: `bay:${bay.id}`,
      layer: 'bays',
      geometry: bay.polygon,
      style: 'bay',
    });
    if (bay.mouth) {
      items.push({
        kind: 'line',
        id: `mouth:${bay.id}`,
        layer: 'bays',
        path: [at(bay.mouth.a), at(bay.mouth.b)],
        style: 'mouth',
      });
    }
    const label = basinLabel(bay.polygon);
    items.push({
      kind: 'label',
      id: `bay-name:${bay.id}`,
      layer: 'bays',
      at: label.at,
      angle: label.angle,
      text: bay.name,
      style: 'bay',
    });
  }
  for (const l of input.landmarks) {
    items.push({
      kind: 'point',
      id: `landmark:${l.id}`,
      layer: 'marks',
      at: at(l.point),
      mark: l.kind,
      name: l.name,
      // "Island · OSM": the kind's one word, then the catalog that vouches for it.
      hoverKicker:
        l.source !== undefined
          ? `${PLACE_KEY_LABELS[l.kind]} · ${l.source.toUpperCase()}`
          : PLACE_KEY_LABELS[l.kind],
    });
  }
  for (const p of input.putIns) {
    items.push({
      kind: 'point',
      id: `putIn:${p.id}`,
      layer: 'putIns',
      at: at(p.coord),
      mark: 'putIn',
      ...(p.name !== undefined ? { name: p.name } : {}),
    });
  }
  for (const p of input.lots) {
    items.push({
      kind: 'point',
      id: `lot:${p.id}`,
      layer: 'putIns',
      at: at(p.coord),
      mark: 'lot',
      ...(p.name !== undefined ? { name: p.name } : {}),
    });
  }
  input.samplePoints.forEach((p, i) => {
    items.push({
      kind: 'point',
      id: `sample:${i}`,
      layer: 'samples',
      at: at(p),
      mark: 'sample',
    });
  });
  return { items };
}
