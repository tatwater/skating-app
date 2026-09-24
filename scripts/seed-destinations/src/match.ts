/**
 * Matching a curated destination shortlist to corpus bodies (A06c §2.3a/§4).
 *
 * **Renamed from `seed-satellite` (founder call, 2026-08-09).** That name was chosen to name the
 * *job* rather than the input list — provision and prove the imagery path. With A06c §2.3's Copernicus deep
 * link deferred to A06e so the whole imagery story lands together, the job this script actually does
 * today is the other half: match a shortlist to rows and set `curatedBoost`. A06e adds the URL
 * verification back on top when it needs it.
 *
 * ## Two commands, never one
 *
 * A `--dry-run` that emits the proposed matches *and the ambiguous ones* as a reviewable file, then
 * an apply step. Founder call: *"I'm happy to look over the seed list first."* Same shape as the
 * other `scripts/` tools' `--prod` guard — a human between the computation and the write.
 *
 * **What the review is for**, stated so the pass isn't perfunctory: not verifying that "Lake
 * Willoughby" matched a row called Lake Willoughby, but catching the two cases the script cannot
 * judge — a destination that matched the *wrong* body of a similar name in the wrong town, and a
 * destination with **no** match. The second is the interesting one: a well-known skating lake absent
 * from a 24,953-body corpus means either a naming mismatch or a genuine gap, and both are worth
 * knowing before boosts go in.
 */

/** One line of the curated shortlist. */
export interface Destination {
  name: string;
  state: string;
  /**
   * Every state the lake might be in, when the list's author knows only where it was *talked
   * about* — the gazetteer's `region` is the posters' state, and Lake Placid is discussed from
   * Vermont. Tried together; a name that matches in two states is ambiguous, as within one.
   */
  states?: string[];
  /** Roughly where it is, for disambiguating same-named bodies. */
  near?: { lat: number; lng: number };
  /**
   * Tightens {@link MATCH_RADIUS_KM} for this entry alone. For a `near` that is *on* the lake rather
   * than in the nearest town — the author looked it up — 25 km is wider than it needs to be, and
   * the corpus holds same-named rows closer than that: "Wentworth Pond" normalizes to "Lake
   * Wentworth" 17.7 km away, and NHD names both Comerford and the McIndoes pool "Connecticut River
   * Reservoir" 15.6 km apart. Never widens: a value above the default is clamped to it, so an
   * entry cannot buy a match a coordinate does not support.
   */
  radiusKm?: number;
  /** Why it is on the list — the community corpus, the atlas survey, or both. */
  sources: ('community' | 'atlas')[];
  notes?: string;
  /**
   * Per-entry override of {@link DESTINATION_BOOST}, e.g. a corpus-graded seed that boosts a
   * heavily-discussed body more than a rarely-mentioned one. Falls back to
   * {@link DESTINATION_BOOST} when absent, so the 40-body hand-curated shortlist (uniformly 0.3)
   * needs no changes.
   */
  curatedBoost?: number;
  /**
   * Marks the entry as a bay/cove/arm rather than a standalone lake — A02/A09 modeled these as
   * `waterBodySubAreas` rows on a parent body, not rows in `waterBodies`, so they need a different
   * candidate pool. Optional: {@link looksLikeBay} infers it from the name when absent, so a
   * corpus-derived list (this file's caller) doesn't have to classify every entry by hand.
   */
  kind?: 'bay';
  /**
   * The parent lake's name, when known — "Lake Champlain" for "Malletts Bay". Narrows a sub-area
   * match the same way {@link Destination.near} narrows a body match: a same-named bay on two
   * different lakes is ambiguous without it.
   */
  parent?: string;
}

/** The corpus rows the matcher considers. */
export interface CandidateBody {
  _id: string;
  name?: string;
  states?: string[];
  surfaceAreaSqM?: number;
  curatedBoost?: number;
  /** The operator's satellite-link override (A06e Workstream 4) — read by the `--verify-imagery` run. */
  satelliteImagery?: 'auto' | 'on' | 'off';
  interiorPoint?: { lat: number; lng: number };
  representativePoint?: { lat: number; lng: number };
  centroid?: { lat: number; lng: number };
  /** The outline's extent, so a `near` on the shore of a 190 km lake reads as *on* it, not 60 km off. */
  bbox?: Bbox;
}

/**
 * A `waterBodySubAreas` row (A02/A09) — "Malletts Bay" as a region of Lake Champlain rather than a
 * lake beside it. Tagged with `kind: 'subArea'` so a matched or ambiguous outcome can tell which
 * table it needs to write through: {@link CandidateBody} carries no such tag (every existing caller
 * already assumes a body), so the presence of `kind` is itself the discriminant.
 *
 * `states` is always the parent's — the row has none of its own (see `packages/convex/convex/schema.ts`
 * `waterBodySubAreas`), so `subAreas:listNamedForSeeding` denormalizes it at read time the same way
 * `searchSubAreas` does for the name box.
 */
export interface CandidateSubArea {
  kind: 'subArea';
  _id: string;
  name: string;
  parentId: string;
  parentName?: string;
  states?: string[];
  surfaceAreaSqM?: number;
  curatedBoost?: number;
  representativePoint?: { lat: number; lng: number };
  centroid?: { lat: number; lng: number };
  bbox?: Bbox;
}

/** Either candidate pool, as a single outcome may match either table. */
export type MatchCandidate = CandidateBody | CandidateSubArea;

/** True for a {@link CandidateSubArea}, false for a {@link CandidateBody} — the discriminant in use. */
export function isSubArea(candidate: MatchCandidate): candidate is CandidateSubArea {
  return (candidate as CandidateSubArea).kind === 'subArea';
}

/** A name ending the way a bay, cove, arm or harbor's does — the inference {@link Destination.kind} skips. */
const BAY_LIKE_SUFFIX = /\b(bay|cove|arm|harbor)$/i;

/**
 * Whether a destination should be matched against sub-area candidates (in addition to bodies) —
 * either the entry says so explicitly, or its name reads like one. Inferred rather than required on
 * every entry, because the corpus-derived shortlist this script actually reviews was generated
 * before A02/A09 existed and re-tagging ~35 bays by hand is exactly the busywork a name suffix can
 * do for free; an explicit `kind` still wins where the suffix would guess wrong (e.g. a lake
 * genuinely named "... Harbor").
 */
export function looksLikeBay(destination: Destination): boolean {
  return destination.kind === 'bay' || BAY_LIKE_SUFFIX.test(destination.name.trim());
}

/** How far a candidate may sit from the shortlist's coordinate and still be the same lake. */
export const MATCH_RADIUS_KM = 25;

/**
 * The radius an entry resolves under: its own, if tighter than the default; never wider.
 *
 * ⚠ **A malformed value throws rather than reading as absent** (Greptile, PR #74). The shortlist
 * is JSON cast to `Destination[]` with no runtime check, so `"radiusKm": "10"` arrives as a
 * string — and falling back to 25 km there would quietly re-admit the very namesake the author
 * wrote the radius to exclude. A value above the default is well-formed and is clamped (the
 * documented "never widens" rule); only a non-number, NaN, infinity or non-positive value is an
 * error, and it stops the dry run before anything is reviewed or applied.
 */
export function radiusFor(destination: Destination): number {
  const own: unknown = destination.radiusKm;
  if (own === undefined) return MATCH_RADIUS_KM;
  if (typeof own !== 'number' || !Number.isFinite(own) || own <= 0) {
    throw new Error(
      `${destination.name} (${destination.state}): radiusKm must be a positive number of km, got ${JSON.stringify(own)}`,
    );
  }
  return Math.min(own, MATCH_RADIUS_KM);
}

/**
 * The boost a seeded destination receives.
 *
 * **0.3, matching every existing curated boost on dev**, and deliberately not more. `displayScore`
 * is `normalize(log area) ∈ [0,1] + curatedBoost` and `minVisibleZoom` clamps the total, so the
 * usable range is small — the A06c-1 build found the A06c §4.2 table's proposed weights were ~13× the whole
 * dynamic range, which would have pushed every named body to the widest zoom bucket with all tests
 * still green. A seed is a cold-start hack with a retirement path (D49), not a permanent registry;
 * profile richness is the durable mechanism meant to take over.
 */
export const DESTINATION_BOOST = 0.3;

/** The boost to apply for a destination: its own override, or {@link DESTINATION_BOOST}. */
export function boostFor(destination: Destination): number {
  return destination.curatedBoost ?? DESTINATION_BOOST;
}

/** Great-circle distance in km. */
export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Normalize a lake name for comparison: case, punctuation and the noise words a gazetteer varies. */
export function normalizeName(name: string): string {
  const bare = name
    .toLowerCase()
    .replaceAll(/['\u2019]/g, '') // Joe's Pond is Joes Pond in GNIS; an apostrophe is not a word break
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const stripped = bare
    .replaceAll(/\b(lake|pond|reservoir|the)\b/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  // A name that is *only* noise words ("Reservoir Pond") must not normalize to "" and match every
  // body called "Reservoir" — 1,375 of them on the first dry run. Compare it whole.
  return stripped.length > 0 ? stripped : bare;
}

/** Where a candidate is, preferring the on-water point for the same reason everything else does. */
export function candidatePoint(
  candidate: MatchCandidate,
): { lat: number; lng: number } | undefined {
  if (isSubArea(candidate)) return candidate.representativePoint ?? candidate.centroid;
  return candidate.interiorPoint ?? candidate.representativePoint ?? candidate.centroid;
}

/** @deprecated Renamed to {@link candidatePoint}, which also accepts a sub-area. */
export const bodyPoint = candidatePoint;

export interface Bbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * How a `near` was measured against a candidate. `point` is the representative point — exact
 * enough for a pond, meaningless for a 190 km lake; `outline` is the true distance to the polygon,
 * fetched on demand; `bbox` is the axis-aligned extent, the lenient fallback when no outline
 * resolver was supplied (a concave lake's box covers inland towns — flagged, never silent).
 */
export type DistanceBasis = 'point' | 'outline' | 'bbox';

export interface ResolvedDistance {
  km: number;
  basis: DistanceBasis;
}

export interface MatchOptions {
  /**
   * True distance from `near` to the candidate's outline in km (0 inside it), or undefined when the
   * polygon can't be had. Called only for the candidates the cheap tests cannot decide — `near`
   * beyond the radius of the point but inside the radius of the bbox — so a run makes a handful of
   * polygon reads, not one per body. The CLI supplies one backed by `waterBodies:get` /
   * `subAreas:listForBody` and core's `distanceToPolygonMeters`.
   */
  outlineDistanceKm?: (
    candidate: MatchCandidate,
    near: { lat: number; lng: number },
  ) => number | undefined;
}

/** Distance from `near` to the candidate's bbox: zero inside, else to the nearest edge. */
function bboxDistanceKm(near: { lat: number; lng: number }, box: Bbox): number {
  const lat = Math.min(Math.max(near.lat, box.minLat), box.maxLat);
  const lng = Math.min(Math.max(near.lng, box.minLng), box.maxLng);
  return distanceKm(near, { lat, lng });
}

/**
 * Resolve `near` against a candidate in three stages, cheapest first (Greptile, PR #69, twice):
 *
 * 1. the point — inside the radius, done: a small body's point is the body;
 * 2. the bbox — if even the extent is beyond the radius, the point distance stands and the
 *    candidate is far by every measure (Charlotte VT is *inside* Champlain's box, so the box is
 *    what stops a shore town on a long lake reading as 30 km off);
 * 3. the outline — `near` is beyond the point but within the box, which is exactly where a
 *    concave lake's box lies: ask for the polygon. No resolver ⇒ the bbox answer, flagged `bbox`.
 *
 * Undefined only when the candidate has no geometry at all.
 */
export function resolveNearDistance(
  near: { lat: number; lng: number },
  candidate: MatchCandidate,
  options: MatchOptions = {},
  radiusKm: number = MATCH_RADIUS_KM,
): ResolvedDistance | undefined {
  const point = candidatePoint(candidate);
  const pointKm = point ? distanceKm(near, point) : undefined;
  if (pointKm !== undefined && pointKm <= radiusKm) return { km: pointKm, basis: 'point' };
  const box = candidate.bbox;
  if (!box) return pointKm === undefined ? undefined : { km: pointKm, basis: 'point' };
  const boxKm = bboxDistanceKm(near, box);
  if (boxKm > radiusKm)
    return { km: pointKm ?? boxKm, basis: pointKm === undefined ? 'bbox' : 'point' };
  const outlineKm = options.outlineDistanceKm?.(candidate, near);
  if (outlineKm !== undefined) return { km: outlineKm, basis: 'outline' };
  return { km: boxKm, basis: 'bbox' };
}

export type MatchOutcome =
  | {
      kind: 'matched';
      destination: Destination;
      /** The matched row — a body or a sub-area; {@link isSubArea} tells them apart. */
      target: MatchCandidate;
      distanceKm?: number;
      /** How `distanceKm` was measured — `bbox` is the lenient fallback and is called out in the report. */
      distanceBasis?: DistanceBasis;
      /**
       * The target is in one of the destination's *mentioned* states, not its headline state, and no
       * coordinate narrowed it — so the only evidence is a unique name in a state people posted
       * from. Reported as a match, never kept on apply (review, PR #64).
       */
      viaMentionedState?: true;
    }
  | { kind: 'ambiguous'; destination: Destination; candidates: MatchCandidate[] }
  | { kind: 'unmatched'; destination: Destination };

/**
 * Resolve one destination against the corpus.
 *
 * **Reports ambiguity rather than guessing, and that is the whole design.** OSM's Northeast water
 * layer is full of bodies named `Mill Pond` and `Beaver Pond`, several within a few miles of each
 * other, and the Phase-02b seed already put five curated boosts on same-named lakes in the wrong
 * towns — invisible until A02 built a screen to look at them. A script that picks the largest
 * candidate would reproduce exactly that, silently.
 *
 * Where a coordinate is supplied, it narrows first: same name *and* within {@link MATCH_RADIUS_KM}
 * (or the entry's tighter {@link Destination.radiusKm}) is a match even when other same-named
 * bodies exist elsewhere in the state, because the coordinate is the disambiguation the shortlist
 * author already did by hand.
 *
 * **Sub-areas join the candidate pool only when {@link looksLikeBay} says so** — a plain lake name
 * has no business matching a bay row, and searching that pool for all ~200 shortlist entries when
 * only ~35 could ever hit it would just be waste. When it does apply, body and sub-area candidates
 * are pooled together for exactly one ambiguity check: a name that resolves in both tables is exactly
 * as ambiguous as a name that resolves twice in one, and the caller (the CLI's report / apply step)
 * tells the two tables apart afterward with {@link isSubArea}, not before.
 */
export function matchDestination(
  destination: Destination,
  bodies: readonly CandidateBody[],
  subAreas: readonly CandidateSubArea[] = [],
  options: MatchOptions = {},
): MatchOutcome {
  const target = normalizeName(destination.name);
  const states = destination.states ?? [destination.state];
  const radiusKm = radiusFor(destination);
  const inState = bodies.filter(
    (body) => body.states?.some((s) => states.includes(s)) && body.name !== undefined,
  );
  const byNameBodies: MatchCandidate[] = inState.filter(
    (body) => normalizeName(body.name as string) === target,
  );

  const parentTarget = destination.parent ? normalizeName(destination.parent) : undefined;
  const byNameSubAreas: MatchCandidate[] = looksLikeBay(destination)
    ? subAreas.filter((subArea) => {
        if (normalizeName(subArea.name) !== target) return false;
        if (!subArea.states?.some((s) => states.includes(s))) return false;
        // A parent name is given: it must match, or a same-named bay on the wrong lake would slip
        // through as unambiguous. No parent given is not evidence either way — fall through to the
        // ordinary ambiguity/near handling below, same as a body with no `near`.
        if (parentTarget) return normalizeName(subArea.parentName ?? '') === parentTarget;
        return true;
      })
    : [];

  const byName = [...byNameBodies, ...byNameSubAreas];

  if (byName.length === 0) return { kind: 'unmatched', destination };
  if (byName.length === 1) {
    const found = byName[0] as MatchCandidate;
    const inHeadlineState = found.states?.includes(destination.state) ?? false;
    const resolved = destination.near
      ? resolveNearDistance(destination.near, found, options, radiusKm)
      : undefined;
    const distance = resolved?.km;
    // One name match is not a match when a `near` says it is the wrong one: a corpus town centroid
    // and a sole same-named body 54 km away is the body the catalog *lacks* plus a decoy, and the
    // decoy would take the boost. The same radius the multi-candidate branch applies (Greptile,
    // PR #69). Reported as ambiguous so the reviewer sees the decoy and its distance.
    // …unless the entry named the bay's parent and this sub-area is on it: the parent already
    // disambiguates, and a corpus `near` for a bay is often the sender's town rather than the
    // bay's (Little Eagle Bay's one mention came from Burlington, 30 km down the lake).
    const parentVouches = isSubArea(found) && parentTarget !== undefined;
    if (distance !== undefined && distance > radiusKm && !parentVouches) {
      return { kind: 'ambiguous', destination, candidates: byName };
    }
    const narrowed = distance !== undefined;
    return {
      kind: 'matched',
      destination,
      target: found,
      ...(resolved ? { distanceKm: resolved.km, distanceBasis: resolved.basis } : {}),
      ...(!inHeadlineState && !narrowed ? { viaMentionedState: true as const } : {}),
    };
  }

  if (destination.near) {
    const near = destination.near;
    const within = byName
      .map((candidate) => {
        const r = resolveNearDistance(near, candidate, options, radiusKm);
        return r === undefined ? null : { candidate, r };
      })
      .filter(
        (x): x is { candidate: MatchCandidate; r: ResolvedDistance } =>
          x !== null && x.r.km <= radiusKm,
      )
      .sort((a, b) => a.r.km - b.r.km);
    if (within.length === 1) {
      const only = within[0] as { candidate: MatchCandidate; r: ResolvedDistance };
      return {
        kind: 'matched',
        destination,
        target: only.candidate,
        distanceKm: only.r.km,
        distanceBasis: only.r.basis,
      };
    }
    if (within.length > 1) {
      return { kind: 'ambiguous', destination, candidates: within.map((w) => w.candidate) };
    }
    // A name match in the right state but none inside the radius is NOT a match — the coordinate
    // says the author meant a different lake, and the nearest same-named one is a decoy.
    return { kind: 'ambiguous', destination, candidates: byName };
  }

  return { kind: 'ambiguous', destination, candidates: byName };
}

/** Resolve the whole shortlist, partitioned for review. */
export function matchAll(
  destinations: readonly Destination[],
  bodies: readonly CandidateBody[],
  subAreas: readonly CandidateSubArea[] = [],
  options: MatchOptions = {},
): MatchOutcome[] {
  return destinations.map((destination) =>
    matchDestination(destination, bodies, subAreas, options),
  );
}

/**
 * Where the two source lists agree, and where they don't (Workstream 4's cross-check).
 *
 * **The disagreement is the interesting part.** A spot the community talks about constantly that no
 * atlas lists is a discovery signal; a listed spot nobody discusses may be listed for scenery rather
 * than for ice.
 */
export function corroboration(destination: Destination): 'both' | 'community' | 'atlas' {
  const hasCommunity = destination.sources.includes('community');
  const hasAtlas = destination.sources.includes('atlas');
  if (hasCommunity && hasAtlas) return 'both';
  return hasCommunity ? 'community' : 'atlas';
}
