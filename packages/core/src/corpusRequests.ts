/**
 * Corpus requests (N7b PR 2) — **the skater says "this is skateable", and the catalogue answers.**
 *
 * D91 put a floor under the corpus and deleted 102,000 bodies on one sentence: *"if I get user
 * feedback that someone's pond isn't there, then we can relax the rule and re-run the import."* That
 * fallback never existed as anything but a sledgehammer. This is the scalpel: a skater points at
 * water — or at a lake we know but shelved — and asks. A moderator answers.
 *
 * Five kinds of request, because the corpus has four non-active standings and one more thing a person
 * can ask for (`standing.ts`):
 *
 * - **`activate`** — the body is in the corpus and dormant. *"Put it back on the active map."* The
 *   common case once the corpus is tiered, and the cheapest: no geometry, no catalogue, one decision.
 * - **`admit`** — nothing in the corpus at this coordinate. *"This is water; we skate it."* The
 *   resolver asks the catalogue for the polygon (D106) and a moderator admits it with its real
 *   geometry, `includedByRequest` (D107). The user never draws.
 * - **`restore`** — the body was removed (D48). *"That was wrong, or things changed."*
 * - **`contest_access`** — a moderator ruled no public access. *"There is a way in, and here it is."*
 * - **`takedown`** — *"I own this; please take it off the map."* The intake D48 deferred to Phase 7
 *   and nobody built. Founder call 2026-09-16: the fifth kind, here.
 *
 * ## Why a request is a proposal and a moderator admits (D107)
 *
 * The floor deleted 102,000 bodies and most of them are farm dugouts, retention basins and widenings
 * in a brook. One tap is not evidence against that; it is a request to look. The review is cheap —
 * for `admit` the moderator is approving *geometry that already exists in a catalogue*, not
 * adjudicating a drawing — and a declined request stays as a record, so the same pond asked for by
 * four people reads as four people rather than one unanswered tap.
 *
 * ## The resolver runs against the live service, not the archives (inverting the plan's order)
 *
 * The plan said archives first, `hydro.nationalmap.gov` second. But "the archives" is a laptop, and a
 * request that waits on a person at a terminal is a request nobody answers. A Convex action can ask
 * the live 3DHP waterbody layer — the same service `measure3dhp` already queries, re-publishing NHD,
 * which is frozen — for the polygon under a point in one call. The archive stays as the manual
 * fallback for the day the service is down. Whichever answers, the candidate records which one and
 * what it returned: a body admitted by request has a provenance story exactly as much as one admitted
 * by a campaign.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import {
  type BBox,
  type LatLng,
  pointInPolygon,
  polygonBBox,
  representativePoint,
  surfaceAreaSqM,
} from './geometry';
import type { Standing } from './standing';
import type { WaterBodyClass } from './types';
import { classifyThreeDhp } from './waterClass';

// ── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

export const REQUEST_KINDS = [
  'activate',
  'admit',
  'restore',
  'contest_access',
  'takedown',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/**
 * A request's life: `open` until a moderator decides; `approved` or `declined` after. For an `admit`,
 * `open` also covers the window before the resolver has answered — the queue shows whether a
 * candidate is attached.
 */
export const REQUEST_STATUSES = ['open', 'approved', 'declined'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** A skater's note on a request — one sentence, rendered to a moderator. */
export const MAX_REQUEST_NOTE_LENGTH = 280;

/**
 * How far an `admit` coordinate may sit from a body we already hold and still be "new water". Inside
 * this, the ask is really about that body — the server refuses with `known_water` and the clients
 * pre-resolve with the same margin so the form never opens for a lake we have.
 */
export const ADMIT_KNOWN_WATER_MARGIN_M = 50;

/**
 * Which kinds a body's standing admits. The drawer offers exactly these, and the server refuses the
 * rest, so the two cannot disagree about what can be asked of a lake.
 *
 * - active: only a takedown — there is nothing to ask *for*.
 * - dormant on the machine's or a moderator's account: bring it back, or take it down.
 * - dormant on a `none` ruling: contest the ruling, or take it down.
 * - removed: ask for a restore. A takedown of a removed body is redundant.
 * - unlisted: nothing — reads follow a merge to the survivor, and a rejected drawing is gone.
 */
export function requestKindsFor(
  standing: { standing: Standing; reason?: string } | undefined,
): RequestKind[] {
  if (!standing) return ['admit'];
  switch (standing.standing) {
    case 'active':
      return ['takedown'];
    case 'dormant':
      return standing.reason === 'no_public_access'
        ? ['contest_access', 'takedown']
        : ['activate', 'takedown'];
    case 'removed':
      return ['restore'];
    case 'unlisted':
      return [];
  }
}

/** The button label for each kind — the skater's words, not the moderator's. */
export function requestKindLabel(kind: RequestKind): string {
  switch (kind) {
    case 'activate':
      return 'Ask for this lake back';
    case 'admit':
      return 'This is skateable';
    case 'restore':
      return 'Ask to restore this lake';
    case 'contest_access':
      return 'There is public access';
    case 'takedown':
      return 'I own this — take it off the map';
  }
}

/** The dialog a request opens — title, one sentence of guidance, and an example note. */
export interface RequestPrompt {
  title: string;
  description: string;
  placeholder: string;
}

export function requestPrompt(kind: RequestKind): RequestPrompt {
  switch (kind) {
    case 'activate':
      return {
        title: 'Ask for this lake back',
        description:
          'Tell the moderators why it belongs on the active map — when you skate it, how you get on.',
        placeholder: 'We skate it most Januarys; the town launch is on the north shore.',
      };
    case 'admit':
      return {
        title: 'This is skateable',
        description:
          'We don’t have water here. Say what it is and how you reach it; a moderator will look it up in the catalogue and add it with its real outline.',
        placeholder: 'A pond behind the school; the trail from the parking lot reaches the shore.',
      };
    case 'restore':
      return {
        title: 'Ask to restore this lake',
        description: 'This lake was taken off the map. If that has changed, say what changed.',
        placeholder: 'The land was sold to the town in 2027 and the sign came down.',
      };
    case 'contest_access':
      return {
        title: 'There is public access',
        description:
          'A moderator found no lawful way in. If there is one, say where — a launch, a right-of-way, a town lot.',
        placeholder: 'State boat launch off Route 5, open year-round.',
      };
    case 'takedown':
      return {
        title: 'Take this lake off the map',
        description:
          'If you own the land around this water and don’t want people sent here, say so. An admin will remove it; you can still record your own skates on it.',
        placeholder:
          'I own the parcel; there is no public access and we’d rather not have visitors.',
      };
  }
}

/** The moderator-facing label. */
export function requestKindTitle(kind: RequestKind): string {
  switch (kind) {
    case 'activate':
      return 'Activate';
    case 'admit':
      return 'Admit';
    case 'restore':
      return 'Restore';
    case 'contest_access':
      return 'Contest access ruling';
    case 'takedown':
      return 'Takedown';
  }
}

/** What the requester reads once a moderator has answered. */
export function describeRequestOutcome(request: {
  kind: RequestKind;
  status: RequestStatus;
  decisionNote?: string;
}): string | null {
  if (request.status === 'open') return null;
  const head =
    request.status === 'approved'
      ? request.kind === 'takedown'
        ? 'A moderator took this lake off the map.'
        : request.kind === 'admit'
          ? 'A moderator added this water to the map.'
          : 'A moderator put this lake back on the active map.'
      : 'A moderator reviewed your request and left things as they are.';
  return request.decisionNote ? `${head} ${request.decisionNote}` : head;
}

// ── The resolver's pure half ───────────────────────────────────────────────────────────────────

/**
 * The 3DHP waterbody layer on the National Map — the same endpoint `scripts/etl` measures. 3DHP
 * re-publishes NHD across the whole Northeast (D92: 68% byte-identical, the rest float round-trip),
 * so a polygon from here is the polygon a campaign would import.
 */
export const CATALOGUE_POINT_SERVICE =
  'https://hydro.nationalmap.gov/arcgis/rest/services/3DHP_all/MapServer/60/query';

/** The fields the resolver asks for — `THREE_DHP_SELECT` in the ETL, plus nothing. */
export const CATALOGUE_POINT_FIELDS = [
  'id3dhp',
  'gnisid',
  'gnisidlabel',
  'featuretype',
  'areasqkm',
];

/** The one-call point query: every waterbody feature intersecting the coordinate, as GeoJSON. */
export function catalogueQueryUrl(coord: LatLng): string {
  const params = new URLSearchParams({
    geometry: `${coord.lng},${coord.lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: CATALOGUE_POINT_FIELDS.join(','),
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });
  return `${CATALOGUE_POINT_SERVICE}?${params.toString()}`;
}

/** What the resolver attaches to an `admit` request when the catalogue knows the water. */
export interface CatalogueCandidate {
  source: '3dhp';
  /** `id3dhp` — the catalogue's own id, and the row's `externalId` / `threeDhpId` if admitted. */
  externalId: string;
  gnisId?: string;
  name: string;
  /** Our class, from 3DHP's `featuretype`; absent when the catalogue calls it a river or a canal. */
  cls?: WaterBodyClass;
  featureType: number;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  centroid: LatLng;
  surfaceAreaSqM: number;
  serviceUrl: string;
  fetchedAt: number;
}

export type CatalogueResolution =
  | { kind: 'found'; candidate: CatalogueCandidate }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

/**
 * Turn the service's answer into a candidate — or say plainly why not.
 *
 * Several features can intersect one point (a lake and the bay polygon inside it; a river reach
 * over a pond). The **smallest** containing polygon is the one somebody tapped: a tap on a cove is a
 * request for the cove's lake, but a tap on a pond drawn inside a wetland is a request for the pond.
 * A feature whose class we refuse (a river, a canal, an ocean) is still returned as a candidate with
 * no `cls`, so the moderator sees *why* there is nothing to admit rather than an empty queue row.
 */
export function parseCatalogueResponse(
  json: unknown,
  coord: LatLng,
  now: number,
): CatalogueResolution {
  const body = json as {
    error?: { message?: string };
    features?: {
      geometry?: { type?: string } | null;
      properties?: Record<string, unknown> | null;
    }[];
  };
  if (body?.error) return { kind: 'error', message: body.error.message ?? 'service error' };
  if (!Array.isArray(body?.features)) return { kind: 'error', message: 'no features array' };

  const containing = body.features
    .map((f) => {
      const raw = f.geometry;
      if (!raw || (raw.type !== 'Polygon' && raw.type !== 'MultiPolygon')) return null;
      const geometry = raw as Polygon | MultiPolygon;
      if (!pointInPolygon(coord, geometry)) return null;
      return { geometry, properties: f.properties ?? {} };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map((f) => ({ ...f, area: surfaceAreaSqM(f.geometry) }))
    .sort((a, b) => a.area - b.area);

  const pick = containing[0];
  if (!pick) return { kind: 'none' };

  const p = pick.properties;
  const id = p.id3dhp;
  if (typeof id !== 'string' && typeof id !== 'number') {
    return { kind: 'error', message: 'feature carries no id3dhp' };
  }
  const featureType = Number(p.featuretype);
  const claim = Number.isFinite(featureType) ? classifyThreeDhp(featureType) : null;
  const name = typeof p.gnisidlabel === 'string' ? p.gnisidlabel.trim() : '';
  const gnisId = p.gnisid;
  return {
    kind: 'found',
    candidate: {
      source: '3dhp',
      externalId: String(id),
      ...(gnisId !== undefined && gnisId !== null && gnisId !== ''
        ? { gnisId: String(gnisId) }
        : {}),
      name,
      ...(claim?.outcome === 'class' ? { cls: claim.cls } : {}),
      featureType: Number.isFinite(featureType) ? featureType : -1,
      polygon: pick.geometry,
      bbox: polygonBBox(pick.geometry),
      centroid: representativePoint(pick.geometry),
      surfaceAreaSqM: pick.area,
      serviceUrl: catalogueQueryUrl(coord),
      fetchedAt: now,
    },
  };
}
