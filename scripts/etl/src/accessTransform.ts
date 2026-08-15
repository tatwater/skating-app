/**
 * The access transform (N6d B1/B2): OSM features → put-in candidates and parking areas.
 *
 * ## What this does and, more importantly, what it cannot
 *
 * The pairing here is **OSM-to-OSM** — which lot serves which launch, and which toilet block is at
 * which lot. All of it needs the extract and nothing else, so it runs locally, in this file, tested.
 *
 * The other association — *which body does this launch belong to* — **cannot** run here, and that is
 * the N6d kickoff's third correction. The transform has no polygons: post-N7 the merge output is not
 * the loaded corpus (bodies are pruned, deduped, re-keyed and retired after it), so measuring against
 * anything local would be measuring against a snapshot that has already moved. That join runs
 * server-side in `waterBodies.matchAndImportAccessPoints`, against the N1 cell index, exactly as N6a's
 * depth join does — and it inherits the same benefit: an access point and the app's own "you're at
 * Lake X" resolution agree by construction, because both go through `listedBodiesNearCoord`.
 *
 * The split is what keeps this pipeline in the standard four stages. Route the walk *here*, where the
 * pairs are, and the loader only has to answer the question it alone can answer. The alternative —
 * load, query back the unrouted pairs, route, patch — is a shape none of the other three ETLs has.
 *
 * ## Why there are no trails in here
 *
 * The plan's B1 table extracts `highway=path` / `route=hiking` for a `trail` amenity. ORS
 * `foot-hiking` routes over exactly those ways, so a successful approach route **is** the evidence a
 * trail exists (correction 9) — and dropping them removed the only line geometry this pipeline would
 * have had to handle. The `trail` amenity is therefore stamped by the routing stage, not the parser.
 */

import {
  AMENITY_NEAR_PARKING_M,
  haversineMeters,
  type LatLng,
  PARKING_INFER_RADIUS_M,
  representativePoint,
} from '@skating/core';
import type { Feature, Geometry, MultiPolygon, Point, Polygon } from 'geojson';

/** What an extracted OSM feature turned out to be. */
export type AccessFeatureKind = 'put_in' | 'parking' | 'toilets';

/** One parsed OSM access feature, reduced to what the pairing and the loader need. */
export interface AccessFeature {
  kind: AccessFeatureKind;
  /** `way/123` / `node/456` — the stable OSM identity, and the idempotent upsert key. */
  externalId: string;
  point: LatLng;
  name?: string;
  /** A launch you can put a boat down. Promotes the paired lot's `boat_ramp` amenity. */
  isSlipway: boolean;
  capacity?: number;
  fee?: boolean;
}

/** Properties `osmium export -a type,id` emits: flat tags plus the two `@` attributes. */
export type OsmAccessProperties = Record<string, unknown> & {
  '@type'?: string;
  '@id'?: number | string;
};

export type OsmAccessFeature = Feature<Geometry, OsmAccessProperties>;

/**
 * OSM `access` values that mean *you may not park here*.
 *
 * Filtered out rather than carried with a flag, because a lot you are not allowed to use is not a
 * worse access point — it is not an access point, and showing it would send someone to a driveway.
 * `customers` is on the list for the same reason: a restaurant's lot is not a public launch, however
 * conveniently it sits.
 */
const CLOSED_ACCESS_VALUES = new Set(['private', 'no', 'customers', 'permit']);

/** The tag pairs that make a feature a put-in candidate. Order is irrelevant; any one is enough. */
const PUT_IN_TAGS: readonly (readonly [string, string])[] = [
  ['leisure', 'slipway'],
  ['waterway', 'slipway'],
  ['natural', 'beach'],
  ['leisure', 'fishing'],
  ['man_made', 'pier'],
];

const SLIPWAY_TAGS: readonly (readonly [string, string])[] = [
  ['leisure', 'slipway'],
  ['waterway', 'slipway'],
];

function tagIs(props: OsmAccessProperties, key: string, value: string): boolean {
  return typeof props[key] === 'string' && props[key] === value;
}

/**
 * The representative coordinate for a feature, whichever geometry type it arrived as.
 *
 * A parking lot is a polygon and a toilet block is a node, and the access pass exports **both** —
 * unlike the water pass, which takes polygons alone. Handling one and silently skipping the other is
 * the specific way this stage would fail quietly: `osmium export` emits fewer features rather than
 * erroring, so a polygon-only parser would report success over an extract missing most of its
 * put-in candidates (many slipways are nodes).
 *
 * Polygons go through `representativePoint`, which is guaranteed to land *inside* the ring — a
 * centroid can fall outside an L-shaped lot, and a lot's centroid outside the lot is a coordinate we
 * would then route a car to.
 */
export function accessFeaturePoint(geometry: Geometry | null): LatLng | null {
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const [lng, lat] = (geometry as Point).coordinates;
    return typeof lat === 'number' &&
      typeof lng === 'number' &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
      ? { lat, lng }
      : null;
  }
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    try {
      return representativePoint(geometry as Polygon | MultiPolygon);
    } catch {
      return null;
    }
  }
  return null;
}

/** OSM `capacity` as a count, or nothing. Never inferred from a lot's area — that is a guess. */
function parseCapacity(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * OSM `fee` as a tri-state.
 *
 * `undefined` means *nobody said*, which is emphatically not *free*. OSM's `fee` key takes values well
 * beyond yes/no (`interval`, a price, `donation`), and reading an unrecognised one as `false` would
 * publish "no fee" on a lot that charges — the kind of small confident wrongness D3 is about.
 */
function parseFee(raw: unknown): boolean | undefined {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  return undefined;
}

/**
 * Classify one exported OSM feature, or refuse it.
 *
 * Returns `null` for anything that isn't access — including a parking area tagged closed to the
 * public, which is refused here rather than carried, since a lot you may not use is not an access
 * point with a caveat.
 */
export function parseAccessFeature(feature: OsmAccessFeature): AccessFeature | null {
  const props = feature.properties ?? {};
  const type = props['@type'];
  const id = props['@id'];
  if (typeof type !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) return null;
  const externalId = `${type}/${id}`;

  const point = accessFeaturePoint(feature.geometry);
  if (!point) return null;

  const name = typeof props.name === 'string' && props.name.trim() ? props.name.trim() : undefined;

  if (tagIs(props, 'amenity', 'parking')) {
    if (typeof props.access === 'string' && CLOSED_ACCESS_VALUES.has(props.access)) return null;
    return {
      kind: 'parking',
      externalId,
      point,
      name,
      isSlipway: false,
      capacity: parseCapacity(props.capacity),
      fee: parseFee(props.fee),
    };
  }

  if (tagIs(props, 'amenity', 'toilets')) {
    return { kind: 'toilets', externalId, point, name, isSlipway: false };
  }

  if (PUT_IN_TAGS.some(([k, val]) => tagIs(props, k, val))) {
    return {
      kind: 'put_in',
      externalId,
      point,
      name,
      isSlipway: SLIPWAY_TAGS.some(([k, val]) => tagIs(props, k, val)),
    };
  }

  return null;
}

/** A parking area as the loader receives it. */
export interface ParkingRecord {
  externalId: string;
  point: LatLng;
  name?: string;
  amenities: ('toilets' | 'trail' | 'boat_ramp')[];
  capacity?: number;
  fee?: boolean;
  /**
   * Did a put-in candidate claim this lot?
   *
   * **The loader's water-relevance gate, and it exists because the first real run measured the
   * problem.** `amenity=parking` is one of the most common tags in OSM: Vermont alone yields 4,656
   * lots, of which 202 pair with a launch — the rest are supermarkets, schools, fire departments and
   * ski clubs. ("East Montpelier Fire Department, Incorporated" is a real row from that run.)
   *
   * An unpaired lot is kept only if the *loader* finds water near it, which the transform cannot test
   * because it has no polygons. A **paired** lot is kept regardless of distance, because that is
   * exactly the mile-in trailhead this phase exists for — pairing is a human-mapped relationship
   * between a lot and a launch, and it outranks any proximity guess.
   */
  paired: boolean;
}

/** A put-in candidate as the loader receives it, with its approach already resolved. */
export interface PutInRecord {
  externalId: string;
  point: LatLng;
  name?: string;
  /** The lot that serves it, if the OSM pass found one within `PARKING_INFER_RADIUS_M`. */
  parkingExternalId?: string;
  approachMeters?: number;
  approachAscentM?: number;
  approachRouted?: boolean;
}

/** What the pairing produced, plus the counters the run row reports. */
export interface AccessPairing {
  parking: ParkingRecord[];
  putIns: PutInRecord[];
  stats: {
    putInsWithParking: number;
    putInsWithoutParking: number;
    parkingWithoutPutIn: number;
    toiletsMatched: number;
    toiletsOrphaned: number;
  };
}

/** The nearest of `candidates` to `point` within `radius`, or nothing. */
function nearestWithin<T extends { point: LatLng }>(
  point: LatLng,
  candidates: readonly T[],
  radius: number,
): T | undefined {
  let best: T | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = haversineMeters(point, candidate.point);
    if (distance <= radius && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Pair launches to lots and lots to amenities — the whole of the local half of B2.
 *
 * **Nearest-within-radius, not every-within-radius.** A launch has one place you park for it; letting
 * a launch claim three overlapping lots would put three directions targets on one marker and leave the
 * choice to whichever the read happened to sort first. The many-to-many that D72's amendment cares
 * about is a *lot serving several bodies*, which is a different relation and lives in
 * `parkingAreaBodies`.
 *
 * Every lot is emitted whether or not it paired with a launch: a trailhead lot with no mapped slipway
 * is exactly the case this phase exists for, and the server-side join can still attach it to a body by
 * shoreline proximity. `parkingWithoutPutIn` is counted rather than filtered, because the number is
 * how we find out whether `PARKING_INFER_RADIUS_M` is set anywhere near right.
 */
export function pairAccessFeatures(
  features: readonly AccessFeature[],
  parkingRadiusM: number = PARKING_INFER_RADIUS_M,
): AccessPairing {
  const parkingFeatures = features.filter((f) => f.kind === 'parking');
  const putInFeatures = features.filter((f) => f.kind === 'put_in');
  const toiletFeatures = features.filter((f) => f.kind === 'toilets');

  const amenitiesByParking = new Map<string, Set<'toilets' | 'trail' | 'boat_ramp'>>();
  for (const lot of parkingFeatures) amenitiesByParking.set(lot.externalId, new Set());

  let toiletsMatched = 0;
  for (const toilet of toiletFeatures) {
    const lot = nearestWithin(toilet.point, parkingFeatures, AMENITY_NEAR_PARKING_M);
    if (!lot) continue;
    amenitiesByParking.get(lot.externalId)?.add('toilets');
    toiletsMatched++;
  }

  const pairedParking = new Set<string>();
  const putIns: PutInRecord[] = putInFeatures.map((candidate) => {
    const lot = nearestWithin(candidate.point, parkingFeatures, parkingRadiusM);
    if (!lot)
      return { externalId: candidate.externalId, point: candidate.point, name: candidate.name };
    pairedParking.add(lot.externalId);
    if (candidate.isSlipway) amenitiesByParking.get(lot.externalId)?.add('boat_ramp');
    return {
      externalId: candidate.externalId,
      point: candidate.point,
      name: candidate.name,
      parkingExternalId: lot.externalId,
    };
  });

  const parking: ParkingRecord[] = parkingFeatures.map((lot) => ({
    externalId: lot.externalId,
    point: lot.point,
    name: lot.name,
    // Sorted so the emitted NDJSON is byte-stable across runs — a diffable artifact is how the
    // eyeballing pass B2 asks for actually gets done.
    amenities: [...(amenitiesByParking.get(lot.externalId) ?? [])].sort(),
    capacity: lot.capacity,
    fee: lot.fee,
    paired: pairedParking.has(lot.externalId),
  }));

  return {
    parking,
    putIns,
    stats: {
      putInsWithParking: putIns.filter((p) => p.parkingExternalId).length,
      putInsWithoutParking: putIns.filter((p) => !p.parkingExternalId).length,
      parkingWithoutPutIn: parkingFeatures.length - pairedParking.size,
      toiletsMatched,
      toiletsOrphaned: toiletFeatures.length - toiletsMatched,
    },
  };
}
