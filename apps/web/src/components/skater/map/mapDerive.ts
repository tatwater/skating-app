/**
 * The pure half of `SkaterMap`: turning the rows the queries return into what the map draws — the
 * label models, the hazard marks, the bay names' angles, and what a click landed on. No map library
 * and no React, so every rule here has a test.
 */

import { isActiveRow, type PartialStandingInput, representativePoint } from '@skating/core';
import { LABEL_DOT_RADIUS, labelPriority, labelSlug, MAX_LAKE_LABELS } from '@/lib/lakeLabelLayout';

export interface LatLngLike {
  lat: number;
  lng: number;
}

/** The fields of a `listInViewport` row the labels read. Structural, so a `Doc` satisfies it. */
export interface LabelableBody extends PartialStandingInput {
  _id: string;
  name: string;
  surfaceAreaSqM?: number;
  interiorPoint?: LatLngLike;
  representativePoint?: LatLngLike;
  centroid: LatLngLike;
}

/**
 * Where a body's label dot goes: its interior point (the spot on the water farthest from any shore),
 * never `centroid`, which is Turf's `pointOnFeature` and lands on the shoreline of a curved lake.
 */
export function labelAnchor(body: LabelableBody): LatLngLike {
  return body.interiorPoint ?? body.representativePoint ?? body.centroid;
}

/** Open bounties per body, from `bounties.listOpen`'s rows (each person's ask is its own row). */
export function bountyCountsByBody(
  bounties: readonly { waterBodyId: string }[] | undefined,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const b of bounties ?? []) counts.set(b.waterBodyId, (counts.get(b.waterBodyId) ?? 0) + 1);
  return counts;
}

/**
 * Each asked body's recent report end times, from `reports.recentCardsForBodies`. Every asked id gets
 * an entry, so a missing one means "not read yet" and its label holds its slug back rather than
 * claiming "No recent reports" before it knows. Blocked authors don't count.
 */
export function reportTimesByBody(
  cards: readonly { waterBodyId: string; skateEndTime: number; blocked?: boolean }[] | undefined,
  askedIds: readonly string[],
): ReadonlyMap<string, number[]> | undefined {
  if (cards === undefined) return undefined;
  const times = new Map<string, number[]>(askedIds.map((id) => [id, []]));
  for (const card of cards) {
    if (card.blocked) continue;
    times.get(card.waterBodyId)?.push(card.skateEndTime);
  }
  return times;
}

/**
 * The hazards the map draws: the open lake's from its own read, every other lake's from the
 * viewport read, so the region is never silently hazard-free (D3). While the open lake's read is
 * loading, its viewport rows stand in, so a lake never blinks to empty. `focusIds` names the open
 * lake both ways (the id it was opened by and its survivor's), so one hazard is never drawn twice.
 * A capped viewport read (`truncated`) still draws every row it has — and nothing reads the map's
 * hazard-free stretches as clear ice.
 */
export function mergeHazards<H extends { waterBodyId: string }>(
  focused: readonly H[] | undefined,
  inViewport: readonly H[] | undefined,
  focusIds: ReadonlySet<string>,
): H[] {
  const around = inViewport ?? [];
  const isFocus = (h: H) => focusIds.has(h.waterBodyId);
  const own = focusIds.size === 0 ? [] : (focused ?? around.filter(isFocus));
  return [...own, ...around.filter((h) => !isFocus(h))];
}

export interface LakeLabelModel {
  id: string;
  name: string;
  anchor: LatLngLike;
  /** `null` while the counts load. */
  slug: string | null;
  favorite: boolean;
  openBounties: number;
  inactive: boolean;
  /** Receded: a body the weather filter didn't match, or one this viewer flagged (D166, A06f). */
  dim: boolean;
  priority: number;
}

export interface LabelInputs {
  favoriteIds: ReadonlySet<string>;
  bountyCounts: ReadonlyMap<string, number>;
  /** Recent report times per body; a body with no entry hasn't been read yet. */
  reportTimes: ReadonlyMap<string, number[]> | undefined;
  dimmedIds: ReadonlySet<string>;
  /** The focused lake: it *is* the view, so it carries no label (mock `mascomaOverlay`). */
  focusId: string | null;
  /** Whether the favorites layer is on: off, a star isn't drawn and doesn't lift a label's rank. */
  showFavorites: boolean;
  now: number;
  timeZone?: string;
  limit?: number;
}

/**
 * The labeled set, highest priority first and capped: unnamed water has no label to draw, and the
 * cap is also what bounds the report-count read to a handful of bodies per view.
 */
export function buildLakeLabels(
  bodies: readonly LabelableBody[],
  inputs: LabelInputs,
): LakeLabelModel[] {
  const {
    favoriteIds,
    bountyCounts,
    reportTimes,
    dimmedIds,
    focusId,
    showFavorites,
    now,
    timeZone,
  } = inputs;
  const models = bodies
    .filter((body) => body.name.length > 0 && body._id !== focusId)
    .map((body) => {
      const inactive = !isActiveRow(body);
      const favorite = showFavorites && favoriteIds.has(body._id);
      const openBounties = bountyCounts.get(body._id) ?? 0;
      const times = reportTimes?.get(body._id);
      return {
        id: body._id,
        name: body.name,
        anchor: labelAnchor(body),
        slug: labelSlug({ inactive, skateEndTimes: times, now, timeZone }),
        favorite,
        openBounties,
        inactive,
        dim: dimmedIds.has(body._id),
        priority: labelPriority({
          favorite,
          openBounties,
          recentReports: times?.length ?? 0,
          inactive,
          surfaceAreaSqM: body.surfaceAreaSqM,
        }),
      };
    });
  models.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
  return models.slice(0, inputs.limit ?? MAX_LAKE_LABELS);
}

/** Which bodies' report counts to read: the labeled set before counts arrive, sorted so the key is stable. */
export function labelCountIds(
  bodies: readonly LabelableBody[],
  inputs: Omit<LabelInputs, 'reportTimes' | 'now'>,
): string[] {
  return buildLakeLabels(bodies, { ...inputs, reportTimes: undefined, now: 0 })
    .map((label) => label.id)
    .sort();
}

// ── Hazard marks ──────────────────────────────────────────────────────────────────────────────

export type HazardTone = 'danger' | 'healing' | 'passage';

export interface HazardMarkModel {
  id: string;
  hazardType: string;
  lng: number;
  lat: number;
  tone: HazardTone;
  provisional: boolean;
}

/**
 * One mark per drawn footprint, at a point on it — so a cluster of duplicates (D80) gets one mark,
 * as it gets one outline. A degenerate footprint has no point to stand on and draws no mark; its
 * outline still draws, so it isn't lost.
 */
export function hazardMarksFrom(fc: GeoJSON.FeatureCollection): HazardMarkModel[] {
  const marks: HazardMarkModel[] = [];
  for (const feature of fc.features) {
    const props = feature.properties ?? {};
    const geometry = feature.geometry;
    if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') continue;
    let at: LatLngLike;
    try {
      at = representativePoint(geometry);
    } catch {
      continue;
    }
    marks.push({
      id: String(props.hazardId),
      hazardType: String(props.hazardType ?? ''),
      lng: at.lng,
      lat: at.lat,
      tone: props.passage ? 'passage' : props.healing ? 'healing' : 'danger',
      provisional: props.provisional === true,
    });
  }
  return marks;
}

/** The space a hazard mark takes, halo and selection brackets included — what a label must keep off. */
export const HAZARD_MARK_EXTENT = 16;

/** A mark's box in map px, for the label layout's obstacles. */
export function markObstacle(x: number, y: number, half = HAZARD_MARK_EXTENT) {
  return { left: x - half, top: y - half, right: x + half, bottom: y + half };
}

/** The dot's radius, re-exported for the label component so the two can't disagree. */
export { LABEL_DOT_RADIUS };

// ── Bays ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The angle a bay's name runs at, degrees clockwise from east: the long axis of its outline
 * (principal axis of the vertices, longitude scaled by the latitude's cosine so it's measured on the
 * ground, not in degrees). Folded to ±90° so a name never reads upside down; 0 for a nearly round
 * shape, which has no long axis to follow.
 */
export function bayLabelAngle(polygon: GeoJSON.Geometry): number {
  const rings =
    polygon.type === 'Polygon'
      ? [polygon.coordinates[0] ?? []]
      : polygon.type === 'MultiPolygon'
        ? polygon.coordinates.map((p) => p[0] ?? [])
        : [];
  // The closing vertex repeats the first; counting it twice would tilt a square.
  const pts = rings.flatMap((ring) => {
    const [first, last] = [ring[0], ring[ring.length - 1]];
    const closed = ring.length > 1 && first?.[0] === last?.[0] && first?.[1] === last?.[1];
    return closed ? ring.slice(0, -1) : ring;
  });
  if (pts.length < 3) return 0;
  const meanLat = pts.reduce((s, p) => s + (p[1] ?? 0), 0) / pts.length;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const xs = pts.map((p) => (p[0] ?? 0) * k);
  const ys = pts.map((p) => p[1] ?? 0);
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  xs.forEach((x, i) => {
    const dx = x - mx;
    const dy = (ys[i] as number) - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  });
  // Nearly round (the two axes within 5% of each other) has no long axis to follow.
  const spread = Math.hypot((sxx - syy) / 2, sxy);
  const scale = (sxx + syy) / 2;
  if (scale === 0 || spread / scale < 0.05) return 0;
  // The axis's angle north of east; screen y runs down, so clockwise is its negative.
  const theta = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
  const screen = -theta;
  const folded = screen > 90 ? screen - 180 : screen < -90 ? screen + 180 : screen;
  return Math.round(folded * 10) / 10 || 0;
}

/** Sub-area features (`subAreasToFeatureCollection`'s) with each label point's angle stamped on it. */
export function withBayAngles(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  const angles = new Map<string, number>();
  for (const f of fc.features) {
    if (f.properties?.label !== true && f.geometry) {
      angles.set(String(f.properties?._id), bayLabelAngle(f.geometry));
    }
  }
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) =>
      f.properties?.label === true
        ? {
            ...f,
            properties: { ...f.properties, angle: angles.get(String(f.properties._id)) ?? 0 },
          }
        : f,
    ),
  };
}

// ── Clicks ────────────────────────────────────────────────────────────────────────────────────

/** A rendered feature as far as a click needs it. */
export interface RenderedHit {
  source?: string;
  sourceLayer?: string;
  layerId?: string;
  properties?: Record<string, unknown> | null;
}

/**
 * Whether a click landed on the basemap's water with none of ours over it: the request-a-lake cue.
 * The request flow resolves the coordinate server-side (a dormant body under it is reachable), so
 * this only has to say "water we don't list".
 */
export function isUnlistedWater(hits: readonly RenderedHit[], ourWaterSource = 'water'): boolean {
  if (hits.some((h) => h.source === ourWaterSource)) return false;
  return hits.some((h) => h.sourceLayer === 'water' || h.layerId === 'water');
}

/** The first hit's string property, or `undefined`. */
export function hitProperty(hits: readonly RenderedHit[], key: string): string | undefined {
  for (const hit of hits) {
    const value = hit.properties?.[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
