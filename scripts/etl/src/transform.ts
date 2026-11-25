/**
 * ETL transform (Phase 01) — the tested heart of the OSM water-body pipeline.
 *
 * Turns raw `osmium export` water features into canonical bodies for
 * `waterBodies.importCanonical`: classify OSM tags → our `type` (dropping non-still-water), drop
 * what does not belong in the corpus (`belongsInCorpus` — the D91 area floor plus D96's
 * named-wetland rule), simplify to ~5 m fidelity (D48), then
 * compute `bbox` / on-water `centroid` / surface area
 * from the *simplified* geometry (what actually gets stored). Pure and framework-free — the
 * geometry + classification live in `@skating/core`; this composes them and adds the
 * per-feature resilience the ETL needs (a degenerate polygon is skipped, never aborts a batch).
 */

import {
  belongsInCorpus,
  classifyOsmTags,
  classifyWaterBody,
  fetchOrigin,
  HARD_MIN_SURFACE_AREA_ACRES,
  HARD_MIN_SURFACE_AREA_SQM,
  lakeGeometryStats,
  MAX_PLAUSIBLE_DEPTH_M,
  MIN_SURFACE_AREA_ACRES,
  MIN_SURFACE_AREA_SQM,
  meetsAreaFloor,
  type OsmTagBag,
  osmExternalId,
  polygonBBox,
  representativePoint,
  surfaceAreaSqM,
  type WaterBodyClass,
} from '@skating/core';
import {
  CONVEX_ARRAY_LIMIT,
  largestRingSize,
  maxArrayLength,
  simplifyForStorage,
} from '@skating/core/polygonStorage';
import type { MultiPolygon, Polygon } from 'geojson';
import type { CanonicalBody, OsmDepthRecord, OsmWaterFeature, OsmWaterProperties } from './types';

/**
 * The corpus floor (D91) lives in `@skating/core` because the ETL is not the only thing that applies
 * it — `waterBodies.pruneBelowAreaFloor` enforces the same rule over the rows already stored. Two
 * copies would drift into a prune that deletes what the next import re-adds. Re-exported so the
 * transform's own module stays the one place to read about the pipeline.
 */
export {
  belongsInCorpus,
  HARD_MIN_SURFACE_AREA_ACRES,
  HARD_MIN_SURFACE_AREA_SQM,
  MIN_SURFACE_AREA_ACRES,
  MIN_SURFACE_AREA_SQM,
  meetsAreaFloor,
};

/**
 * Returned by `featureToCanonicalBody` for a feature that classified fine but is below the floor —
 * distinct from `null` (classification) so the run summary can tally the two separately. "We import
 * no rivers" and "we import no puddles" are different facts about a run and an operator reading
 * `droppedByType: 60,000` should not be looking at a number that silently means both.
 */
export const BELOW_AREA_FLOOR = 'below_area_floor' as const;

/**
 * Transform one OSM feature into a canonical body, or a skip:
 *  - `null` — **skipped by classification** (rivers / streams / the ocean / … — `classifyWaterBody`
 *    returns a `null` class, meaning "not water we cover" rather than "water of unknown kind").
 *  - `BELOW_AREA_FLOOR` — real still water the corpus does not want (`belongsInCorpus`): too
 *    small to be a destination, or unnamed wetland (D96).
 *
 * **Throws** on data we can't turn into a storable body: a missing `@type`/`@id`, a non-area
 * geometry, a degenerate polygon `representativePoint` can't place a point on, or a geometry
 * that still breaches Convex's 8192-element array cap after coarsening. Batching raw OSM must
 * catch per feature (see `transformFeatures`) — raw data carries enough junk geometry that a
 * single throw must not kill the import (phase-01 plan / PR#1 review P2).
 */
/**
 * Keep only the string-valued tags, because `osmium export -a type,id` does not emit only strings.
 *
 * The old call site cast straight through (`props as OsmTags`) and got away with it: OSM tag values
 * genuinely are strings, and the classifier only reads `water` / `wetland` / `landuse` / `natural` /
 * `waterway`. But `@id` is emitted as a **number**, so the cast was asserting something false about
 * the same object — and `readTag` calls `.split(';')` on whatever it is handed, which turns a
 * numeric tag into a `TypeError` inside a per-feature try/catch, i.e. a silently skipped body.
 */
function stringTags(props: OsmWaterProperties): OsmTagBag {
  const out: OsmTagBag = {};
  for (const [k, v] of Object.entries(props)) if (typeof v === 'string') out[k] = v;
  return out;
}

function requireMinimumRingSize(geometry: Polygon | MultiPolygon): void {
  if (largestRingSize(geometry) < 4) {
    throw new Error('degenerate geometry: no ring with 4+ positions (cannot form a closed area)');
  }
}

/** Measure the source before simplification and check the stored geometry against Convex's cap. */
function prepareBodyGeometry(geometry: Polygon | MultiPolygon) {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    throw new Error(`unsupported geometry type "${(geometry as { type: string }).type}"`);
  }
  requireMinimumRingSize(geometry);

  // D85: measuring after simplification under-reports perimeter, especially on crenellated lakes.
  const stats = lakeGeometryStats(geometry);
  const interiorPoint = fetchOrigin(geometry) ?? undefined;
  const polygon = simplifyForStorage(geometry);
  const maxArray = maxArrayLength(polygon);
  if (maxArray > CONVEX_ARRAY_LIMIT) {
    throw new Error(
      `geometry array too large (${maxArray} > ${CONVEX_ARRAY_LIMIT}) after coarsening`,
    );
  }
  const centroid = representativePoint(polygon); // throws on a collapsed / degenerate ring
  return { stats, interiorPoint, polygon, centroid };
}

/**
 * Turn a **classified, admitted** body into the record `importCanonical` stores — source-agnostic
 * (A07a step 5).
 *
 * ## Why this had to be lifted out of `featureToCanonicalBody`
 *
 * The geometry work below — D85's source-measured stats, ~5 m simplification, the Convex array cap,
 * an on-water representative point — is identical whoever drew the polygon. It was welded to an
 * `OsmWaterFeature`, which meant the merge had **no way to emit a loadable body at all**:
 * `master.ndjson` carried a name, a class and an acreage and no geometry, so it was a report rather
 * than an artifact. Re-using the OSM path was not an option either, because it re-runs its own
 * classifier and floor and would have overruled the merge that just decided both.
 *
 * So the split is: **callers decide *whether* a body belongs and *what it is*; this decides what it
 * looks like.** `featureToCanonicalBody` is now the OSM-only wrapper that classifies and applies the
 * floor before calling in here.
 *
 * **Throws** on geometry we cannot store — a degenerate ring, or an array still over Convex's 8192
 * cap after coarsening. Callers batching raw data must catch per body.
 */
export function toCanonicalBody(input: {
  source: CanonicalBody['source'];
  externalId: string;
  name: string;
  type: WaterBodyClass;
  geometry: Polygon | MultiPolygon;
  osmId?: string | undefined;
  nhdId?: string | undefined;
  threeDhpId?: string | undefined;
  gnisId?: string | undefined;
  geometrySource?: CanonicalBody['geometrySource'];
  states?: string[] | undefined;
  /** The admitting area — see `CanonicalBody.sourceAreaSqM`. */
  sourceAreaSqM?: number | undefined;
  inRegionFraction?: number | undefined;
  confidence?: CanonicalBody['confidence'];
  reviewReasons?: readonly string[] | undefined;
  /** Every publisher's name, the losers included — see `CanonicalBody.nameClaims`. */
  nameClaims?:
    | readonly { source: string; value: string; sources?: readonly string[] | undefined }[]
    | undefined;
  /** Every catalog's class (B01-3d), with its token and area (B01-7a) — see `CanonicalBody.classClaims`. */
  classClaims?:
    | readonly { source: string; value: string; token?: string; areaSqM?: number }[]
    | undefined;
  /**
   * The catalogs that refused this water (B01-7a) — see `CanonicalBody.classRefusals`. The merge
   * always passes it, `[]` when none refused; a caller that can't know (the OSM-only lane sees one
   * catalog) leaves it out, and the record omits it.
   */
  classRefusals?: readonly { source: string; token: string; areaSqM?: number }[] | undefined;
  /** The features the merge folded into this body (B01-7a, D310) — see `CanonicalBody.absorbedFeatures`. */
  absorbedFeatures?: readonly { source: string; externalId: string; areaSqM: number }[] | undefined;
}): CanonicalBody {
  const { stats, interiorPoint, polygon, centroid } = prepareBodyGeometry(input.geometry);
  return {
    source: input.source,
    externalId: input.externalId,
    name: input.name,
    type: input.type,
    polygon,
    bbox: polygonBBox(polygon),
    centroid,
    surfaceAreaSqM: surfaceAreaSqM(polygon),
    ...(input.osmId ? { osmId: input.osmId } : {}),
    ...(input.nhdId ? { nhdId: input.nhdId } : {}),
    ...(input.threeDhpId ? { threeDhpId: input.threeDhpId } : {}),
    ...(input.gnisId ? { gnisId: input.gnisId } : {}),
    ...(input.geometrySource ? { geometrySource: input.geometrySource } : {}),
    ...(input.states?.length ? { states: input.states } : {}),
    // **The area the admission decision was actually made on.** `surfaceAreaSqM` above is measured
    // from the simplified polygon, because that is what we draw; the floor is applied to the source
    // geometry, because that is the more accurate measure. They differ by well under a percent — and
    // that is enough to put a body admitted at 1.0001 acres under `pruneBelowAreaFloor`'s 1-acre
    // bar, so the import adds it and the next prune deletes it, forever. Carrying both lets the two
    // passes agree; see `waterBodies.sourceAreaSqM`.
    ...(input.sourceAreaSqM !== undefined ? { sourceAreaSqM: input.sourceAreaSqM } : {}),
    ...(input.inRegionFraction !== undefined ? { inRegionFraction: input.inRegionFraction } : {}),
    ...(input.confidence ? { confidence: input.confidence } : {}),
    ...(input.reviewReasons?.length ? { reviewReasons: [...input.reviewReasons] } : {}),
    // Omitted rather than stored empty, like every other optional above: an unnamed body has no
    // claims, and a row carrying `[]` reads as "we looked and found none" rather than "no name".
    ...(input.nameClaims?.length
      ? {
          nameClaims: input.nameClaims.map(({ sources, ...c }) => ({
            ...c,
            ...(sources !== undefined ? { sources: [...sources] } : {}),
          })),
        }
      : {}),
    ...(input.classClaims?.length ? { classClaims: input.classClaims.map((c) => ({ ...c })) } : {}),
    // **Emitted empty, unlike the claims above** (B01-7a): `[]` is the merge's answer — it looked and
    // no catalog refused — which the import stores as such, while an absent list is a record that
    // doesn't know (an older loader's, or the OSM-only lane's), and the import keeps what is stored.
    ...(input.classRefusals !== undefined
      ? { classRefusals: input.classRefusals.map((r) => ({ ...r })) }
      : {}),
    // **Emitted empty, as the refusals are** (D310): the merge passes the list for every body it
    // keeps, so `[]` is its answer — it absorbed nothing — and the import replaces a stale list with
    // it. An absent list (the OSM-only lane's) is a record that doesn't know, and the import keeps
    // what is stored.
    ...(input.absorbedFeatures !== undefined
      ? { absorbedFeatures: input.absorbedFeatures.map((a) => ({ ...a })) }
      : {}),
    ...(interiorPoint ? { interiorPoint } : {}),
    ...stats,
  };
}

export function featureToCanonicalBody(
  feature: OsmWaterFeature,
): CanonicalBody | null | typeof BELOW_AREA_FLOOR {
  const props: OsmWaterProperties = feature.properties ?? {};
  const rawName = typeof props.name === 'string' ? props.name : '';
  // **One classifier, shared with the merge** (A07a, D109 amendment). This used to call an OSM-only
  // mapper into the retired vocabulary; `classifyWaterBody` reads the same tags into the stored one
  // and additionally lets a name overrule a tag — which is what keeps Higley Flow out of the drop
  // list and Debsconeag Deadwater in the `river` class.
  const { cls: type } = classifyWaterBody({
    name: rawName,
    claim: classifyOsmTags(stringTags(props)),
  });
  if (type === null) return null;

  const externalId = osmExternalId(props);
  if (externalId === null) {
    throw new Error('feature is missing @type/@id (export with `osmium export -a type,id`)');
  }

  const geom = feature.geometry;
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
    throw new Error(`unsupported geometry type "${geom.type}" (expected a polygon area)`);
  }

  const name = rawName;

  // Degenerate geometry has to fail **before** the floor, or it stops being visible. A closed linear
  // ring needs four positions; anything less measures as zero area, which the floor would happily
  // read as "a very small pond" and tally into a bucket of ~100,000. This used to surface as a throw
  // from `representativePoint` further down — the check is now explicit and named, because the floor
  // moved in front of it and a broken polygon must never be indistinguishable from a puddle.
  requireMinimumRingSize(geom);

  // The floor (founder call, 2026-08-02), checked **here** — after classification, before any of the
  // per-body geometry below. Four fifths of a raw extract fails it, and shoreline + axes + a
  // 16-bearing fetch profile on 100,000 bodies we then discard is the most expensive way not to
  // import something.
  //
  // Measured on the SOURCE geometry, like the D85 stats and unlike the stored `surfaceAreaSqM`
  // (which is derived from the simplified polygon a few lines down, because that's what we draw).
  // The two differ by well under a percent, so a body can in principle store an area a hair under
  // the floor it cleared. That is the right way round: the source is the more accurate measure, and
  // the alternative is doing the expensive work first to decide with a worse number.

  if (!belongsInCorpus({ name, type, surfaceAreaSqM: surfaceAreaSqM(geom) })) {
    return BELOW_AREA_FLOOR;
  }

  // The geometry half is shared with the merge's emit stage — see `toCanonicalBody`. `osmId` is
  // stated explicitly rather than left for the server to infer from `source`: an incoming record
  // asserts its own identity (D93), and this path knows perfectly well what OSM calls it.
  return toCanonicalBody({
    source: 'osm',
    externalId,
    name,
    type,
    geometry: geom,
    osmId: externalId,
    geometrySource: 'osm',
  });
}

// ── OSM depth tags (A06a rung 7) ──────────────────────────────────────────────────────────────
//
// The roadmap filed this as "the ETL update carrying OSM `depth`/`maxdepth` tags where they exist",
// folded into A06a — and the A06a review found it had never been written, leaving `osm_tag` an enum value
// with no producer. It rides *this* pass rather than the depth ETL's, because the tags arrive with the
// OSM export and the depth pipeline never sees an OSM feature.

/** Feet → meters, for a tag that spells its unit. */
const M_PER_FOOT = 0.3048;

/**
 * Parse an OSM depth tag value to meters, or `undefined` if it isn't an unambiguous single depth.
 *
 * **Deliberately strict**, because this is the bottom rung and a wrong number here is worse than no
 * number: a bare value is meters (the OSM default unit), an explicit `m` / `ft` / `'` is converted, and
 * everything else — ranges (`2-3`), approximations (`~5`), comparisons (`>10`), unparseable junk — is
 * refused rather than guessed at. There is no unit *detection* here and there can't be: `10` might be a
 * chart in feet, which is precisely why this rung sits below every model in the ladder.
 */
export function parseOsmDepthMeters(raw: unknown): number | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const text = String(raw).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(m|meter|meters|metre|metres|ft|feet|foot|')?$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2];
  const meters =
    unit === 'ft' || unit === 'feet' || unit === 'foot' || unit === "'"
      ? value * M_PER_FOOT
      : value;
  // Same backstop the operator field and the depth loader carry — a lake in our region is not 400 m deep.
  return meters > MAX_PLAUSIBLE_DEPTH_M ? undefined : meters;
}

/**
 * A depth record from one feature's tags, or `null` when it has none we can use.
 *
 * **`depth` maps to the *max*, never the mean, and that asymmetry is the safety-relevant call.** OSM's
 * `depth` is documented loosely — mappers use it for a typical, a mean and a maximum — so mapping it to
 * `meanDepthM` would put an unsupported claim in the field that *wins* the shallow classification
 * (`isShallowDepth` prefers a mean whenever one exists). Read as a max it enters through the generous
 * 7 m fallback instead, which is the direction that keeps a shallow lake classified shallow. Only the
 * explicit `depth:mean` — rare, and unambiguous when present — is trusted as a mean.
 */
export function depthFromOsmTags(
  props: OsmWaterProperties,
  externalId: string,
): OsmDepthRecord | null {
  const meanDepthM = parseOsmDepthMeters(props['depth:mean']);
  // `maxdepth` is the better claim; a bare `depth` fills in only when it's the one on offer.
  const maxDepthM = parseOsmDepthMeters(props.maxdepth) ?? parseOsmDepthMeters(props.depth);
  if (meanDepthM === undefined && maxDepthM === undefined) return null;
  if (meanDepthM !== undefined && maxDepthM !== undefined && meanDepthM > maxDepthM) {
    return null; // transposed or mismatched tags — the same refusal `setDepth` makes
  }
  return {
    source: 'osm',
    externalId,
    ...(meanDepthM !== undefined ? { meanDepthM, meanDepthSource: 'osm_tag' as const } : {}),
    ...(maxDepthM !== undefined ? { maxDepthM, maxDepthSource: 'osm_tag' as const } : {}),
  };
}

/** Per-feature outcome tally for the run summary. */
export interface TransformSummary {
  /** Features seen. */
  total: number;
  /** Bodies produced (imported). */
  imported: number;
  /** Skipped by classification — non-still-water we defer this phase (rivers, wetland, …). */
  droppedByType: number;
  /**
   * Skipped by `belongsInCorpus` — still water, too small and unnamed to be
   * anywhere. Expect this to be the **largest** number in the summary: ~4 of every 5 features.
   */
  droppedByAreaFloor: number;
  /** Skipped because the feature threw (bad geometry / missing id) — see `errors`. */
  skipped: number;
  /** Bodies carrying a usable OSM depth tag (A06a rung 7). Expect a handful: inland coverage is ~nil. */
  depthsTagged: number;
}

/** A feature that threw during transform, kept for the run summary rather than aborting. */
export interface TransformError {
  externalId: string;
  message: string;
}

export interface TransformOutput {
  bodies: CanonicalBody[];
  /** Depths tagged on the bodies above — a separate stream for a separate mutation (A06a rung 7). */
  depths: OsmDepthRecord[];
  summary: TransformSummary;
  errors: TransformError[];
}

/**
 * Transform a batch of features, isolating each failure (skip + tally) so one bad polygon
 * never aborts the import (phase-01 plan / PR#1 review P2). `droppedByType` is intentional
 * classification skips and `droppedByAreaFloor` is the intentional size floor; `skipped` (with
 * `errors`) is features that threw.
 */
export function transformFeatures(features: Iterable<OsmWaterFeature>): TransformOutput {
  const bodies: CanonicalBody[] = [];
  const depths: OsmDepthRecord[] = [];
  const errors: TransformError[] = [];
  let total = 0;
  let droppedByType = 0;
  let droppedByAreaFloor = 0;

  for (const feature of features) {
    total++;
    try {
      const body = featureToCanonicalBody(feature);
      if (body === null) {
        droppedByType++;
        continue;
      }
      if (body === BELOW_AREA_FLOOR) {
        droppedByAreaFloor++;
        continue;
      }
      bodies.push(body);
      // Only for a body we're actually storing: a depth keyed to an `externalId` no row carries would
      // count as `unmatched` in the loader forever, which is noise, not a finding.
      const depth = depthFromOsmTags(feature.properties ?? {}, body.externalId);
      if (depth) depths.push(depth);
    } catch (err) {
      errors.push({
        externalId: osmExternalId(feature.properties) ?? String(feature.id ?? '(unknown)'),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    bodies,
    depths,
    summary: {
      total,
      imported: bodies.length,
      droppedByType,
      droppedByAreaFloor,
      skipped: errors.length,
      depthsTagged: depths.length,
    },
    errors,
  };
}
