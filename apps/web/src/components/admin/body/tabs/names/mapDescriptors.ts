/**
 * ⚠ **The frame's file, copied verbatim** from `components/admin/body/map/mapDescriptors.ts` on
 * `b01-3-body-frame` (2026-11-13), so the Names, Places, Access and Water tabs can be built against
 * the real contract before the frame lands. At integration this file is deleted and every import
 * of it points at the frame's. Everything above the "Contract requests" block at the bottom is the
 * frame's text, unchanged; the block is what these tabs need that the frame's types can't say yet.
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Contract requests (B01-3, the Names / Places / Access / Water tabs) — NOT in the frame's file.
// Each is a new member these tabs draw; at integration the frame adds it to its own union (and its
// palette) and this block goes. Until then the tabs' scenes are typed `TabMapScene`, which is the
// frame's `BodyMapScene` widened by exactly these members.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A point's face, widened:
 * - `proposal` — a skater's proposed landmark (Places): a dashed square with a `?`, since a
 *   proposal has no kind until a moderator gives it one. Distinct from any landmark kind's plate.
 */
export type TabMapPointMark = MapPointMark | 'proposal';

/**
 * A line, widened:
 * - `approach` — the walk from a lot to its put-in, as routed (Access): the drawer's dashed walk.
 * - `dimension` — a survey's dimension line along one side of the body's box (Water), with its
 *   end ticks: what decides whether one weather point is enough.
 */
export type TabMapLineStyle = MapLineStyle | 'approach' | 'dimension';

/**
 * A label, widened:
 * - `measure` — a dimension line's length ("4.9 KM"), set into the line: spaced mono caps, quiet.
 */
export type TabMapLabelStyle = MapLabelStyle | 'measure';

export type TabMapPoint = Omit<MapPoint, 'mark'> & { mark: TabMapPointMark };
export type TabMapLine = Omit<MapLine, 'style'> & { style: TabMapLineStyle };
export type TabMapLabel = Omit<MapLabel, 'style'> & { style: TabMapLabelStyle };
export type TabMapItem = MapOutline | TabMapLine | TabMapPoint | TabMapLabel;

/** `BodyMapScene`, widened by the members above. */
export interface TabMapScene extends Omit<BodyMapScene, 'items'> {
  items: readonly TabMapItem[];
}
