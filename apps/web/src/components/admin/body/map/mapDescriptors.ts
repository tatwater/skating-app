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
  | 'footprint'
  /**
   * An outline that is not ours yet (the Inbox): a catalog's candidate for an admit, or a skater's
   * drawing over a known body. Dashed in the bright ink, drawn over the shore it is weighed against.
   */
  | 'candidate';

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
  | 'leader'
  /** The walk from a lot to its put-in, as routed (Access): the skater drawer's dashed walk. */
  | 'approach'
  /**
   * A survey's dimension line along one side of the body's box (Water), with a tick across each
   * end — what decides whether one weather point is enough. Pair it with a `measure` label.
   */
  | 'dimension'
  /**
   * A distance between two things the Inbox weighs (an asked point and its lookalike, a candidate
   * and the nearest body of ours): a dashed rule, drawn on the map. Pair it with a `measure` label.
   */
  | 'gap';

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
  | 'photo'
  /**
   * A skater's proposed landmark (Places): a dashed square with a question mark, since a proposal
   * has no kind until a moderator gives it one.
   */
  | 'proposal'
  /**
   * The point a flagged report was made at (the Inbox's Safety lane): a ring with four ticks and a
   * dot, in the hazard red — the one safety item on an embed. Any other item's point is `asked`.
   */
  | 'reticle'
  /** The point a skater asked about (the Inbox): the reticle's ring and ticks in the bright ink. */
  | 'asked'
  /**
   * A named place that may be the one asked about (the Inbox's Places lane): a dashed amber ring
   * with a dot — amber because it is a question the moderator answers, never a hazard.
   */
  | 'lookalike';

/** How a label is set. */
export type MapLabelStyle =
  /** A bay's name, run along its basin: spaced caps, quiet. */
  | 'bay'
  /** A town's name beside a town line: spaced caps, quieter. */
  | 'town'
  /** A place's name beside its mark: sentence case. */
  | 'place'
  /** A dimension line's length ("4.9 KM"), set into the line: spaced mono caps, quiet. */
  | 'measure';

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
  /**
   * A footprint drawn as a hazard's **dot field** (Hazards) instead of a flat plate: dots across
   * the footprint in the hazard's tone, dimmed by `freshness` — **a stale hazard fades and is never
   * removed** (D3) — and a step further while `provisional` (no second witness yet). A known body
   * feature (`known`) draws at full strength: it has no clock. Only a `footprint` carries one.
   */
  field?: MapHazardField;
}

/** What a footprint's dot field says: how fresh, which tone, and whether anyone confirmed it. */
export interface MapHazardField {
  freshness: 'fresh' | 'aging' | 'stale' | 'known';
  /** `healing` is the amber *healing, still unsafe*; `hazard` is the warning red. */
  tone: 'hazard' | 'healing';
  provisional: boolean;
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
  /** A last line on the plate, under the name ("Windy and Copernicus open here"). */
  caption?: string;
  /**
   * A hazard or known feature drawn as a pin because its shape can't be (Hazards): the field its
   * footprint would have carried, so the pin fades exactly as that field would — **never lighter
   * for the missing shape** (D3) — and a known feature's stays at full strength.
   */
  field?: MapHazardField;
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

/**
 * One archived satellite pass, drawn as the Aerial layer (Imagery): the picture the skater app's
 * imagery reveal paints (`useFreezeUpFrame`), a quiet raster under the outline — never over it. One
 * per scene; the frame draws the first it is handed.
 */
export interface MapRaster extends MapItemBase {
  kind: 'raster';
  layer: 'aerial';
  /** The frame's object key in the imagery archive. */
  key: string;
  granuleId: string;
  band: string;
  capturedAt: string;
  /** The archive's season (`winter-2026-27`), for the picture's credit; `null` while unread. */
  season: string | null;
}

export type MapItem = MapOutline | MapLine | MapPoint | MapLabel | MapRaster;

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
