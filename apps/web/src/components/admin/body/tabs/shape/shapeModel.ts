import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';
import { type Loadable, mapLoadable } from '@/components/admin/reads/consoleReads';
import { acresFigure, dayMonth, firstName, ringsText } from '../../frame/bodyModel';
import type { Neighbor, TouchingFacts } from '../../frame/touching';
import type { BodyMapScene } from '../../map/mapDescriptors';

/**
 * The Shape tab's default view (5.4.1), from the records — pure. The outline leads (the plainest
 * fact about the shape, its source written out), then the bays (when and how each was made), then
 * the ways to add one. **Merge shows only when another body touches this one** (Review 13 #8) —
 * or when the touching test couldn't say. **`null` is not recorded**, drawn as absent.
 */

/** The catalog a polygon came from, written out where it is the subject (Review 12 #7). */
export const OUTLINE_SOURCES: Record<string, { name: string; tag: string }> = {
  osm: { name: 'OpenStreetMap', tag: 'OSM' },
  nhd: { name: 'National Hydrography Dataset', tag: 'NHD' },
  '3dhp': { name: '3D Hydrography Program', tag: '3DHP' },
  user: { name: 'Drawn by a skater', tag: 'USER' },
};

export interface ShapeOutline {
  source: { name: string; tag: string };
  rings: string;
  /** "238 vertices". */
  vertices: string;
  /** "12 Oct campaign", or the campaign's id when it names no date; `null` if never imported. */
  lastImport: string | null;
}

export interface ShapeBay {
  /** The lit address: `bay:<id>`. */
  id: string;
  name: string;
  /** "612" — whole acres; under one, a tenth ("0.4"), never a zero for water that's there. */
  acres: string;
  /**
   * How and when it was made, and by whom, as far as the record says ("Seeded · 2 Sep · Teagan");
   * *Not recorded yet* when the record was read and holds none of it; `null` while unread.
   */
  sub: string | null;
  /** Something about it waits on a person (a chord that wants a re-fit). */
  attention: string | null;
}

export interface ShapeBody {
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  source: string;
  geometrySource?: string;
  lastCampaignId?: string;
}

/**
 * A bay as Shape keeps it from `subAreas.listForBody`. **What the read returns and Shape doesn't
 * keep, and why** (nothing is dropped by accident):
 * - `aliases`: the Names tab's (a bay's names are named there);
 * - `polygon`, `bbox`, `centroid`: the map's, which draws every bay from the frame's own scene;
 * - `displayScore`, `minVisibleZoom`, `curatedBoost`: how the skater map shows the bay, not part of
 *   its shape (the frame's boost is the body's);
 * - `fetchProfileM`, `maxDepthM`, `maxDepthSource`, `depthUnderstatesMax`, `depthDerivedAt`: the
 *   bay as a place, for the skater's drawer; the console's depths are the body's, on Water;
 * - `geometryUpdatedAt`: when the bay's outline last moved, which History lists as an edit;
 * - a removed bay's reason: a removed bay is in History, not the table.
 * `waterBodies.get`'s other fields are the frame's (identity, towns, trust); `consoleExtras` is the
 * frame's too, except the touching ids Merge lists.
 */
export interface ShapeSubArea {
  _id: string;
  name: string;
  surfaceAreaSqM: number;
  removed: boolean;
  mouth?: unknown;
  /** Why a re-import couldn't derive the stored mouth (the server's reason). */
  mouthStale?: string;
  /** A moved shoreline re-fitted the mouth, and a person should look. */
  mouthReview?: unknown;
  /** When it was made. */
  createdAt?: number;
}

/** How each bay was made (`bodyConsole.bayProvenance`). */
export type BayProvenance = FunctionReturnType<typeof api.bodyConsole.bayProvenance>[number];
type BayVia = NonNullable<BayProvenance['createdVia']>;

/** How a bay was made, in the table's words. */
const VIA_WORDS: Record<BayVia, string> = {
  chord: 'Drawn by chord',
  drawn: 'Drawn',
  seed: 'Seeded',
  catalog: 'From the catalog',
};

/** Every ring's vertices, less each ring's closing repeat. */
export function vertexCount(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): number {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.reduce((n, p) => n + p.reduce((m, ring) => m + Math.max(0, ring.length - 1), 0), 0);
}

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * A campaign id as an operator reads it: the date it carries ("…-20261012" → "12 Oct campaign"),
 * else the id itself.
 */
export function campaignText(id: string): string {
  const m = /(20\d{2})(\d{2})(\d{2})/.exec(id);
  if (m) {
    const [, y, mo, d] = m;
    const at = new Date(Number(y), Number(mo) - 1, Number(d), 12);
    if (at.getMonth() === Number(mo) - 1) return `${dayMonth(at.getTime())} campaign`;
  }
  return id;
}

export function shapeOutline(body: ShapeBody): ShapeOutline {
  const key = body.geometrySource ?? body.source;
  const verts = vertexCount(body.polygon);
  return {
    source: OUTLINE_SOURCES[key] ?? { name: key, tag: key.toUpperCase() },
    rings: ringsText(body.polygon),
    vertices: `${int.format(verts)} ${verts === 1 ? 'vertex' : 'vertices'}`,
    lastImport: body.lastCampaignId === undefined ? null : campaignText(body.lastCampaignId),
  };
}

/** What a bay's sub-line says when the record holds nothing about how, when or by whom. */
export const BAY_NOT_RECORDED = 'Not recorded yet';

/**
 * A bay's sub-line: how it was made (its creating row's `via`; a chord's stored mouth says so when
 * no row does), the day it was made, and who made it — each only as far as the record says. With
 * how each was made read and none of it there, it says so; unread (on its way, failed, or withheld
 * from the viewer), nothing is claimed about the record: `null`, and the row draws no sub-line.
 */
function baySub(
  s: ShapeSubArea,
  made: BayProvenance | undefined,
  provenanceRead: boolean,
  timeZone?: string,
): string | null {
  const via = made?.createdVia ?? null;
  const how = via !== null ? VIA_WORDS[via] : s.mouth !== undefined ? 'Drawn by chord' : null;
  const at = made?.createdAt ?? s.createdAt;
  const parts = [
    how ?? (at !== undefined ? 'Added' : null),
    at !== undefined ? dayMonth(at, timeZone) : null,
    made?.createdBy ? firstName(made.createdBy.displayName) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length > 0) return parts.join(' · ');
  return provenanceRead ? BAY_NOT_RECORDED : null;
}

/**
 * The listed bays, largest first (the read's own order). A removed bay lives in History. With
 * `provenance` (how each was made), each sub-line says how, when and by whom.
 */
export function shapeBays(
  subAreas: readonly ShapeSubArea[],
  provenance?: readonly BayProvenance[],
  timeZone?: string,
): ShapeBay[] {
  const made = new Map((provenance ?? []).map((p) => [p.subAreaId as string, p]));
  return subAreas
    .filter((s) => !s.removed)
    .map((s) => ({
      id: `bay:${s._id}`,
      name: s.name,
      acres: acresFigure(s.surfaceAreaSqM),
      sub: baySub(s, made.get(s._id), provenance !== undefined, timeZone),
      attention:
        s.mouthStale !== undefined
          ? 'Its chord no longer fits the shore'
          : s.mouthReview !== undefined
            ? 'A re-fit waits on a person'
            : null,
    }));
}

// ── Merge ────────────────────────────────────────────────────────────────────────────────────

/** A body that touches this one, as Merge lists it: its lit address and its name. */
export interface ShapeNeighbor {
  /** The lit address: `neighbor:<id>`, the frame's outline of it. */
  lit: string;
  id: string;
  name: string;
}

/** The Merge block: the bodies that touch this one, and what the touching test couldn't say. */
export interface ShapeMerge {
  touching: Loadable<readonly ShapeNeighbor[]>;
  /** What the test left unchecked; `null` when it checked everything near. */
  note: string | null;
}

/** For an outline too large to test, the read says it didn't run: not computed, never "none". */
export const NOT_CHECKED =
  'Whether another body touches this one isn’t checked for an outline this large.';
/** More bodies stood nearby than the test read. */
export const CAPPED_NONE =
  'None of the most prominent bodies nearby touches it; smaller ones weren’t checked.';
export const CAPPED_SOME = 'Among the most prominent bodies nearby; smaller ones weren’t checked.';

/**
 * The Merge block, from the touching test and the neighbors' reads — `null` (no block) only when the
 * test ran over everything near and found none, the board's rule. A test that couldn't run, or
 * stopped short, keeps the block and says so.
 */
export function shapeMerge(
  facts: TouchingFacts,
  neighbors: Loadable<readonly Neighbor[]>,
): ShapeMerge | null {
  if (facts.touchingBodyIds === null) return { touching: [], note: NOT_CHECKED };
  if (facts.touchingBodyIds.length === 0) {
    return facts.touchingCapped ? { touching: [], note: CAPPED_NONE } : null;
  }
  return {
    touching: mapLoadable(neighbors, (list) =>
      list.map((n) => ({ lit: `neighbor:${n.id}`, id: n.id, name: n.name })),
    ),
    note: facts.touchingCapped ? CAPPED_SOME : null,
  };
}

/**
 * The Shape tab's map: nothing of its own — the frame already draws the outline, the bays and the
 * bodies that touch it — but a lit bay or neighbor is lit on the map as in the table.
 */
export function shapeMapScene(_data: unknown, lit: string | null): BodyMapScene {
  return {
    items: [],
    lit: lit?.startsWith('bay:') || lit?.startsWith('neighbor:') ? lit : null,
  };
}
