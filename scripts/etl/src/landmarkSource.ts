/**
 * The landmark pass's two sources, read into one candidate shape (D202) — **every decision about
 * what an OSM feature or a GNIS row *is***. Which body it belongs to is `landmarkMatch.ts`; the
 * subprocesses and files are `landmarkCli.ts`.
 *
 * A candidate is a *named* place with a kind, a label point, and whatever geometry the matcher needs
 * to decide which water it belongs to: a footprint for an island or a beach, a line for a river or a
 * bridge. Unnamed features are dropped here — a landmark is its name.
 */

import type { LandmarkKind, LatLng } from '@skating/core';
import { isValidCoord, representativePoint, surfaceAreaSqM } from '@skating/core';
import type { Feature, Geometry, MultiPolygon, Polygon, Position } from 'geojson';
import { isNullIsland } from './gnisSource';

/**
 * Establishments come in two classes, because the founder's rule treats them differently: a camp,
 * resort or hotel **owns shoreline** and outlasts its signs, so it is always a landmark; a restaurant
 * or a store is one only when it **stands alone** — a row of five is a street, not a reference.
 */
export type EstablishmentClass = 'lodging' | 'food';

export interface LandmarkCandidate {
  /** Stable upstream id, prefixed by source: `osm:way/123`, `gnis:1459987`. */
  sourceId: string;
  source: 'osm' | 'gnis';
  name: string;
  kind: LandmarkKind;
  /** Where the label goes — an island's interior, a node's position. */
  point: LatLng;
  /** The footprint, for sources that drew one. */
  polygon?: Polygon | MultiPolygon;
  areaSqM?: number;
  /** A line's vertices in order — a river in its flow direction (OSM draws waterways downstream). */
  line?: LatLng[];
  establishment?: EstablishmentClass;
}

type Tags = Record<string, unknown>;

const LODGING: Readonly<Record<string, readonly string[]>> = {
  leisure: ['summer_camp', 'resort'],
  tourism: ['camp_site', 'hotel', 'motel', 'resort', 'guest_house'],
};
const FOOD: Readonly<Record<string, readonly string[]>> = {
  amenity: ['restaurant', 'cafe', 'bar', 'pub'],
  shop: ['general'],
};

function tagIn(tags: Tags, table: Readonly<Record<string, readonly string[]>>): boolean {
  return Object.entries(table).some(([key, values]) => values.includes(String(tags[key])));
}

/**
 * What an OSM feature's tags make it, or `null` — **first match wins, in this order**, because one
 * feature often carries two: an island with a hotel on it (`place=island` + `tourism=hotel`) is an
 * island, a dam with a road over it is a dam, a marina's restaurant is a marina.
 *
 * `natural=bay` counts only as a **node**: a bay polygon is a sub-area's outline (A07a imported every
 * one with a parent), and the same bay's node is the landmark. The caller passes the geometry type
 * for that rule and for the settlement one (a `place=town` polygon is a boundary, not a point).
 */
export function osmLandmarkKind(
  tags: Tags,
  geometry: Geometry['type'],
): { kind: LandmarkKind; establishment?: EstablishmentClass } | null {
  const isPoint = geometry === 'Point';
  const place = String(tags.place ?? '');
  const natural = String(tags.natural ?? '');
  const waterway = String(tags.waterway ?? '');
  const manMade = String(tags.man_made ?? '');

  if (place === 'island' || place === 'islet') return { kind: 'island' };
  if (natural === 'cape' || natural === 'peninsula') return { kind: 'point' };
  if (natural === 'bay') return isPoint ? { kind: 'bay' } : null;
  if (natural === 'strait') return { kind: 'narrows' };
  if (waterway === 'dam') return { kind: 'dam' };
  if (['river', 'stream', 'canal'].includes(waterway)) {
    return geometry === 'LineString' || geometry === 'MultiLineString'
      ? { kind: 'waterway' }
      : null;
  }
  if (manMade === 'lighthouse') return { kind: 'lighthouse' };
  if (manMade === 'bridge' || tags['bridge:name'] !== undefined) return { kind: 'bridge' };
  if (tags.leisure === 'marina') return { kind: 'marina' };
  if (natural === 'beach') return { kind: 'beach' };
  if (['town', 'village', 'hamlet'].includes(place)) return isPoint ? { kind: 'settlement' } : null;
  if (tagIn(tags, LODGING)) return { kind: 'establishment', establishment: 'lodging' };
  if (tagIn(tags, FOOD)) return { kind: 'establishment', establishment: 'food' };
  if (natural === 'rock' || natural === 'stone') return { kind: 'other' };
  return null;
}

/**
 * A name that is a site number, not a name: "Campsite #12", "Site 4", "#7". Green River Reservoir's
 * thirty numbered campsites are each a `tourism=camp_site` with a `name`, and none is anything a
 * skater would steer by.
 */
export function isNumberedSite(name: string): boolean {
  return /^(camp\s*site|campsite|site|lean-?to)?\s*#?\s*\d+[a-z]?$/i.test(name.trim());
}

/** The name a feature is known by: a bridge's own name before the road's, else `name`. */
function osmName(tags: Tags, kind: LandmarkKind): string | null {
  const bridgeName = typeof tags['bridge:name'] === 'string' ? tags['bridge:name'] : undefined;
  const raw = kind === 'bridge' ? (bridgeName ?? tags.name) : tags.name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length > 0 && !isNumberedSite(name) ? name : null;
}

const toLatLng = ([lng, lat]: Position): LatLng => ({ lat: lat as number, lng: lng as number });

/** The ordered vertices of a line, or of a polygon's outer ring(s) — what a crossing test walks. */
function vertices(geometry: Geometry): LatLng[] {
  switch (geometry.type) {
    case 'LineString':
      return geometry.coordinates.map(toLatLng);
    case 'MultiLineString':
      return geometry.coordinates.flat().map(toLatLng);
    case 'Polygon':
      return (geometry.coordinates[0] ?? []).map(toLatLng);
    case 'MultiPolygon':
      return geometry.coordinates.flatMap((rings) => rings[0] ?? []).map(toLatLng);
    default:
      return [];
  }
}

/**
 * One OSM feature (an `osmium export` line) as a candidate, or `null` when it is not a landmark, has
 * no name, or has geometry nothing can be placed from. Throws nothing: raw data is raw, and one bad
 * polygon must not end a five-state pass (`representativePoint`'s own warning).
 */
export function parseOsmLandmark(feature: Feature): LandmarkCandidate | null {
  const props = (feature.properties ?? {}) as Tags;
  const type = props['@type'];
  const id = props['@id'];
  if (typeof type !== 'string' || (typeof id !== 'number' && typeof id !== 'string')) return null;
  const geometry = feature.geometry;
  if (!geometry) return null;
  const classified = osmLandmarkKind(props, geometry.type);
  if (!classified) return null;
  const name = osmName(props, classified.kind);
  if (!name) return null;

  const base = {
    sourceId: `osm:${type}/${id}`,
    source: 'osm' as const,
    name,
    kind: classified.kind,
    ...(classified.establishment ? { establishment: classified.establishment } : {}),
  };

  if (geometry.type === 'Point') {
    const point = toLatLng(geometry.coordinates);
    return isValidCoord(point) ? { ...base, point } : null;
  }
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    try {
      const point = representativePoint(geometry);
      return {
        ...base,
        point,
        polygon: geometry,
        areaSqM: surfaceAreaSqM(geometry),
        line: vertices(geometry),
      };
    } catch {
      return null;
    }
  }
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
    const line = vertices(geometry);
    const mid = line[Math.floor(line.length / 2)];
    return mid ? { ...base, point: mid, line } : null;
  }
  return null;
}

/**
 * Keep one candidate per OSM id. `osmium export` writes a closed way twice — as a line *and* as an
 * area — and the area is the one worth keeping (a footprint, an area, an interior label point). For a
 * river the only geometry is the line, so it is kept by default.
 */
export function dedupeOsmById(candidates: readonly LandmarkCandidate[]): LandmarkCandidate[] {
  const byId = new Map<string, LandmarkCandidate>();
  for (const c of candidates) {
    const held = byId.get(c.sourceId);
    if (!held || (c.polygon && !held.polygon)) byId.set(c.sourceId, c);
  }
  return [...byId.values()];
}

/**
 * GNIS classes that name a landmark, and the kind each becomes. `Harbor` is a bay named as a place
 * ("Burlington Harbor"); `Gut` and `Channel` are narrows; `Bar` (a shoal) and `Pillar` (a named rock
 * standing in or beside the water) are the `other` a skater still steers by.
 *
 * `Stream` is absent on purpose: GNIS gives a stream one coordinate, and the mouth — the point that
 * matters here — is where OSM's line meets the shore, which the OSM lane finds exactly.
 */
export const GNIS_LANDMARK_CLASSES: Readonly<Record<string, LandmarkKind>> = {
  Island: 'island',
  Cape: 'point',
  Beach: 'beach',
  Bay: 'bay',
  Harbor: 'bay',
  Gut: 'narrows',
  Channel: 'narrows',
  Bar: 'other',
  Pillar: 'other',
  'Populated Place': 'settlement',
};

/** One GNIS row (already split on `|`) as a candidate, or `null` for a class or row we do not use. */
export function parseGnisLandmark(
  cells: readonly string[],
  columns: { name: number; class: number; lat: number; lng: number; id: number | undefined },
): LandmarkCandidate | null {
  const kind = GNIS_LANDMARK_CLASSES[cells[columns.class] ?? ''];
  if (!kind) return null;
  const name = (cells[columns.name] ?? '').trim();
  const id = columns.id === undefined ? '' : (cells[columns.id] ?? '').trim();
  const lat = Number(cells[columns.lat]);
  const lng = Number(cells[columns.lng]);
  if (!name || !id || !Number.isFinite(lat) || !Number.isFinite(lng) || isNullIsland(lat, lng)) {
    return null;
  }
  const point = { lat, lng };
  if (!isValidCoord(point)) return null;
  return { sourceId: `gnis:${id}`, source: 'gnis', name, kind, point };
}
