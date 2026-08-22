/**
 * Matching a curated destination shortlist to corpus bodies (N6c Workstream B3a/D).
 *
 * **Renamed from `seed-satellite` (founder call, 2026-08-09).** That name was chosen to name the
 * *job* rather than the input list — provision and prove the imagery path. With B3's Copernicus deep
 * link deferred to N6e so the whole imagery story lands together, the job this script actually does
 * today is the other half: match a shortlist to rows and set `curatedBoost`. N6e adds the URL
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
  /** Roughly where it is, for disambiguating same-named bodies. */
  near?: { lat: number; lng: number };
  /** Why it is on the list — the community corpus, the atlas survey, or both. */
  sources: ('community' | 'atlas')[];
  notes?: string;
}

/** The corpus rows the matcher considers. */
export interface CandidateBody {
  _id: string;
  name?: string;
  states?: string[];
  surfaceAreaSqM?: number;
  curatedBoost?: number;
  /** The operator's satellite-link override (N6e Workstream D) — read by the `--verify-imagery` run. */
  satelliteImagery?: 'auto' | 'on' | 'off';
  interiorPoint?: { lat: number; lng: number };
  representativePoint?: { lat: number; lng: number };
  centroid?: { lat: number; lng: number };
}

/** How far a candidate may sit from the shortlist's coordinate and still be the same lake. */
export const MATCH_RADIUS_KM = 25;

/**
 * The boost a seeded destination receives.
 *
 * **0.3, matching every existing curated boost on dev**, and deliberately not more. `displayScore`
 * is `normalize(log area) ∈ [0,1] + curatedBoost` and `minVisibleZoom` clamps the total, so the
 * usable range is small — the N6c-1 build found the D2 table's proposed weights were ~13× the whole
 * dynamic range, which would have pushed every named body to the widest zoom bucket with all tests
 * still green. A seed is a cold-start hack with a retirement path (D49), not a permanent registry;
 * profile richness is the durable mechanism meant to take over.
 */
export const DESTINATION_BOOST = 0.3;

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
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\b(lake|pond|reservoir|the)\b/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** Where a body is, preferring the on-water point for the same reason everything else does. */
export function bodyPoint(body: CandidateBody): { lat: number; lng: number } | undefined {
  return body.interiorPoint ?? body.representativePoint ?? body.centroid;
}

export type MatchOutcome =
  | { kind: 'matched'; destination: Destination; body: CandidateBody; distanceKm?: number }
  | { kind: 'ambiguous'; destination: Destination; candidates: CandidateBody[] }
  | { kind: 'unmatched'; destination: Destination };

/**
 * Resolve one destination against the corpus.
 *
 * **Reports ambiguity rather than guessing, and that is the whole design.** OSM's Northeast water
 * layer is full of bodies named `Mill Pond` and `Beaver Pond`, several within a few miles of each
 * other, and the Phase-2.5 seed already put five curated boosts on same-named lakes in the wrong
 * towns — invisible until N2 built a screen to look at them. A script that picks the largest
 * candidate would reproduce exactly that, silently.
 *
 * Where a coordinate is supplied, it narrows first: same name *and* within {@link MATCH_RADIUS_KM}
 * is a match even when other same-named bodies exist elsewhere in the state, because the coordinate
 * is the disambiguation the shortlist author already did by hand.
 */
export function matchDestination(
  destination: Destination,
  bodies: readonly CandidateBody[],
): MatchOutcome {
  const target = normalizeName(destination.name);
  const inState = bodies.filter(
    (body) => body.states?.includes(destination.state) && body.name !== undefined,
  );
  const byName = inState.filter((body) => normalizeName(body.name as string) === target);

  if (byName.length === 0) return { kind: 'unmatched', destination };
  if (byName.length === 1) {
    const body = byName[0] as CandidateBody;
    const point = bodyPoint(body);
    return {
      kind: 'matched',
      destination,
      body,
      ...(destination.near && point ? { distanceKm: distanceKm(destination.near, point) } : {}),
    };
  }

  if (destination.near) {
    const near = destination.near;
    const within = byName
      .map((body) => {
        const point = bodyPoint(body);
        return point ? { body, d: distanceKm(near, point) } : null;
      })
      .filter((x): x is { body: CandidateBody; d: number } => x !== null && x.d <= MATCH_RADIUS_KM)
      .sort((a, b) => a.d - b.d);
    if (within.length === 1) {
      const only = within[0] as { body: CandidateBody; d: number };
      return { kind: 'matched', destination, body: only.body, distanceKm: only.d };
    }
    if (within.length > 1) {
      return { kind: 'ambiguous', destination, candidates: within.map((w) => w.body) };
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
): MatchOutcome[] {
  return destinations.map((destination) => matchDestination(destination, bodies));
}

/**
 * Where the two source lists agree, and where they don't (Workstream D's cross-check).
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
