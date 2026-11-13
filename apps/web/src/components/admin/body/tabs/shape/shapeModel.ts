import { sqMetersToAcres } from '@skating/core';

import { dayMonth, ringsText } from '../../frame/bodyModel';
import type { BodyMapScene } from '../../map/mapDescriptors';

/**
 * The Shape tab's default view (5.4.1), from the records — pure. The outline leads (the plainest
 * fact about the shape, its source written out), then the bays, then the ways to add one. Merge
 * shows only when another body touches this one (Review 13 #8) — no read says that yet, so it is
 * not drawn. **`null` is not recorded**, drawn as absent.
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
  /** "612" — whole acres. */
  acres: string;
  /** How it was drawn, when the record says. */
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
}

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

/** The listed bays, largest first (the read's own order). A removed bay lives in History. */
export function shapeBays(subAreas: readonly ShapeSubArea[]): ShapeBay[] {
  return subAreas
    .filter((s) => !s.removed)
    .map((s) => ({
      id: `bay:${s._id}`,
      name: s.name,
      acres: int.format(sqMetersToAcres(s.surfaceAreaSqM)),
      sub: s.mouth !== undefined ? 'Drawn by chord' : null,
      attention:
        s.mouthStale !== undefined
          ? 'Its chord no longer fits the shore'
          : s.mouthReview !== undefined
            ? 'A re-fit waits on a person'
            : null,
    }));
}

/**
 * The Shape tab's map: nothing of its own — the frame already draws the outline and the bays — but
 * a lit bay is lit on the map as in the table.
 */
export function shapeMapScene(_data: unknown, lit: string | null): BodyMapScene {
  return { items: [], lit: lit?.startsWith('bay:') ? lit : null };
}
