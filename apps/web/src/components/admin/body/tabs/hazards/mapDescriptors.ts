/*
 * ── THE FRAME'S FILE, COPIED ─────────────────────────────────────────────────────────────────────
 * A verbatim copy of `components/admin/body/map/mapDescriptors.ts` from branch `b01-3-body-frame`
 * (84ec6bc5), so the Imagery, Hazards, Standing and Links tabs build against the real contract
 * before integration. At integration this file is deleted and every import of it points at the
 * frame's `../../map/mapDescriptors`. Only the marked block at the bottom is this builder's: what
 * those four tabs need that the contract can't say yet — each a contract request, none drawn by
 * the frame until it adopts them.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { LandmarkKind } from '@skating/core';

/**
 * **What a Body console tab may ask the map to draw** — the one contract between the frame and the
 * nine tabs. A tab never touches the map: it exports a pure function from its own data to a
 * {@link BodyMapScene}, and the frame draws the scene (its outlines and lines as map layers, its
 * points and labels as marks over the map). A tab that wants something this file can't say asks for
 * a new member here; it never reaches for MapLibre.
 *
 * Plain data only: no colors, no pixel sizes, no React. How each style looks is the frame's
 * business (`bodyMapPalette.ts`), so every tab's drawing reads as one map.
 */

/** A point on the map, in GeoJSON's order: longitude first. */
export type LngLat = readonly [lng: number, lat: number];

/**
 * The map's layers, in the rack's order. Every item names the layer it belongs to, and the rack's
 * switch for that layer shows or hides it. A layer no item belongs to is drawn disabled (it keeps
 * its place and its key, faded and inert).
 */
export const BODY_MAP_LAYERS = [
  'outline',
  'bays',
  'marks',
  'putIns',
  'samples',
  'hazards',
  'features',
  'tracks',
  'aerial',
  'bathy',
] as const;
export type BodyMapLayer = (typeof BODY_MAP_LAYERS)[number];

/** How an outline is drawn. */
export type MapOutlineStyle =
  /** The body's own shore: the brightest line on the map, a faint lift inside it. */
  | 'body'
  /** A bay (a sub-area): a dashed line, so where it meets the shore the shore wins. */
  | 'bay'
  /** Another body that touches or nearly touches this one: quiet, dashed. */
  | 'neighbor'
  /** An area that belongs to something on the body (a hazard's footprint, a feature): a filled plate. */
  | 'footprint';

/** How a line is drawn. */
export type MapLineStyle =
  /** Where one bay ends and the next begins (a chord across the water): dotted. */
  | 'divider'
  /** A chord bay's mouth, as stored: solid. */
  | 'mouth'
  /** A town line (a boundary on land): a long dash and a dot. */
  | 'townLine'
  /** A skated path. */
  | 'track'
  /** A thin rule from a mark to whatever names it. */
  | 'leader';

/**
 * A point's face. A landmark wears its kind (`@skating/core`'s `LANDMARK_KINDS` — a settlement is
 * a town, a waterway a river); the rest are the things a body's map can hold.
 */
export type MapPointMark =
  | LandmarkKind
  | 'putIn'
  | 'lot'
  | 'sample'
  | 'hazard'
  | 'healing'
  | 'passage'
  | 'feature'
  | 'photo';

/** How a label is set. */
export type MapLabelStyle =
  /** A bay's name, run along its basin: spaced caps, quiet. */
  | 'bay'
  /** A town's name beside a town line: spaced caps, quieter. */
  | 'town'
  /** A place's name beside its mark: sentence case. */
  | 'place';

interface MapItemBase {
  /**
   * Unique within the scene, and the address `?lit=` uses for it (`bay:<id>`, `landmark:<id>`), so
   * the row a tab lights and the thing on the map are one id.
   */
  id: string;
  /** The rack switch that shows or hides it. */
  layer: BodyMapLayer;
}

export interface MapOutline extends MapItemBase {
  kind: 'outline';
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  style: MapOutlineStyle;
}

export interface MapLine extends MapItemBase {
  kind: 'line';
  /** Two points or more, in order. */
  path: readonly LngLat[];
  style: MapLineStyle;
}

export interface MapPoint extends MapItemBase {
  kind: 'point';
  at: LngLat;
  mark: MapPointMark;
  /** What it is called, for a reader and for its hover plate. */
  name?: string;
  /** The hover plate's kicker ("Island · OSM"); without it the plate shows the name alone. */
  hoverKicker?: string;
}

export interface MapLabel extends MapItemBase {
  kind: 'label';
  /** The label's center. */
  at: LngLat;
  text: string;
  style: MapLabelStyle;
  /**
   * The angle the text runs at, in degrees clockwise from east (a bay's name along its basin).
   * Leave it out for level text.
   */
  angle?: number;
}

export type MapItem = MapOutline | MapLine | MapPoint | MapLabel;

/** What a tab wants drawn, beside what the frame always draws. */
export interface BodyMapScene {
  items: readonly MapItem[];
  /** The item the tab has lit (`?lit=`) — drawn bright and never faded by a hover. */
  lit?: string | null;
  /**
   * The layers this tab turns on or off when it opens (Hazards opens with Hazards on). The rack
   * starts from these each time the tab changes; the operator's own switches win after that.
   */
  layers?: Partial<Record<BodyMapLayer, boolean>>;
}

/** A scene with nothing in it: what a tab that draws nothing of its own hands the frame. */
export const EMPTY_SCENE: BodyMapScene = { items: [] };

// ── CONTRACT REQUESTS (this builder's, not the frame's) ──────────────────────────────────────────
// Each extends a contract type structurally, so a scene that carries them still type-checks as a
// `BodyMapScene` and the frame draws the plain item until it adopts the extra fields.

/**
 * Hazards: a footprint drawn as the hazard's **dot field** (`hazardGeometry.ts`' cells, dimmed by
 * freshness, never removed), not a flat plate. `freshness` dims it (a stale hazard fades, never
 * goes); `known` is a body feature, drawn at full strength with no clock; `healing` is the amber
 * "healing, still unsafe"; `provisional` (no second witness yet) fades it a step further.
 */
export interface MapHazardField extends MapOutline {
  style: 'footprint';
  field: {
    freshness: 'fresh' | 'aging' | 'stale' | 'known';
    tone: 'hazard' | 'healing';
    provisional: boolean;
  };
}

/**
 * Imagery: one satellite pass drawn as the Aerial layer — a quiet raster under the outline, never
 * brighter than it — from the imagery archive the app's stepper reads (`frame.key`).
 */
export interface MapRaster {
  kind: 'raster';
  /** `pass:<granuleId>`, the address `?lit=` uses. */
  id: string;
  layer: 'aerial';
  granuleId: string;
  band: string;
  capturedAt: string;
  /** The frame's object key in the archive. */
  key: string;
}

/** A scene that also carries rasters (the Imagery tab's). */
export interface BodyMapSceneWithRasters extends BodyMapScene {
  rasters?: readonly MapRaster[];
}

/**
 * Links (and Water): a point's plate with a last line under its name — "Windy and Copernicus open
 * here" under the interior point's coordinate.
 */
export interface MapPointWithCaption extends MapPoint {
  caption?: string;
}
