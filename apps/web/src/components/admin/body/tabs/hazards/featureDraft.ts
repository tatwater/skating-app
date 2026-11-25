import {
  BODY_FEATURE_TYPE_LABELS,
  type BodyFeatureType,
  HAZARD_MAX_SIZE_M,
  HAZARD_MAX_VERTICES,
  type HazardShape,
  hazardFootprint,
  isValidHazardShape,
  type LatLng,
} from '@skating/core';

import type { BBoxLike } from '@/lib/mapSurface';
import { unwrapGeometry } from '@/lib/polygonDraw';

/**
 * **A known feature on the drawing board** (B01-6b, D300): the one piece of state the Hazards tab
 * holds while the map draws a feature — what it is for, how it is drawn, the fields, and the shape
 * as it stands. Pure but for the session counter: the tab keeps it in state and steps it with these
 * functions, and the map tool claim is read off it.
 *
 * - **What it is for** (`target`): a new feature, or a feature's shape redrawn. A redraw opens on the
 *   feature's own shape, in its own way, ready to edit — but a feature stored in several parts can
 *   only be drawn again from nothing, as one outline.
 * - **The way** fixes the map's engine: an outline (a traced ring), a point with a radius (a click),
 *   a line with a band (a traced line), or a pasted GeoJSON shape the map only shows. Changing the
 *   way starts the shape over — except going back to a redrawn feature's own way, which puts its
 *   shape back.
 * - **The shape** is what the save sends, sized by the radius or the band; the map's draft is its
 *   footprint (`hazardFootprint`), the same halo the console and the skater apps draw.
 */

export type FeatureWay = 'polygon' | 'point' | 'line' | 'paste';

/** The ways a feature can be drawn, in the order the picker offers them. */
export const FEATURE_WAYS: readonly FeatureWay[] = ['polygon', 'point', 'line', 'paste'];

export const FEATURE_WAY_LABELS: Record<FeatureWay, string> = {
  polygon: 'Outline',
  point: 'Point',
  line: 'Line',
  paste: 'Paste',
};

/** The smallest radius or band the task takes, in meters: the old editor's floor. */
export const FEATURE_SIZE_MIN_M = 1;
/** The largest: the hazards' own ceiling, which the server holds every shape to. */
export const FEATURE_SIZE_MAX_M = HAZARD_MAX_SIZE_M;
/** A new point's radius: the old editor's. */
export const DEFAULT_FEATURE_RADIUS_M = 30;
/** A new line's band: a pressure ridge's (`HAZARD_DEFAULT_BUFFER_M`), the line most features are. */
export const DEFAULT_FEATURE_BAND_M = 15;

type Geometry = GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** A feature's stored shape, as the redraw opens on it. */
export interface StoredFeatureShape {
  geometryKind: 'point_radius' | 'line' | 'polygon';
  geometry: unknown;
  radiusMeters?: number | undefined;
  bufferMeters?: number | undefined;
}

export type FeatureTarget =
  | { kind: 'new' }
  | {
      kind: 'redraw';
      featureId: string;
      /** "Spring / current", for the header and the receipt. */
      label: string;
      /** The way the feature was drawn, and its shape to edit (none for one in several parts). */
      way: Exclude<FeatureWay, 'paste'>;
      geometry: Geometry | null;
      radiusMeters?: number;
      bufferMeters?: number;
      /** Stored in several parts: drawn again from nothing, as one outline. */
      multi: boolean;
      bbox: BBoxLike | null;
    };

export interface FeatureDraft {
  /** A new value starts the map's drawing over (the tool claim's session). */
  session: number;
  target: FeatureTarget;
  way: FeatureWay;
  type: BodyFeatureType;
  note: string;
  /** As typed, in meters. */
  radius: string;
  band: string;
  paste: string;
  /** The shape as it stands: the point, the traced line or ring, or the parsed paste. */
  geometry: Geometry | null;
  /** Why the paste isn't a shape. */
  refusal: string | null;
  /** The draw engine couldn't load: paste is the way left. */
  unavailable: boolean;
  /** Where the camera goes as the drawing starts. */
  focus: { point: LatLng } | { bbox: BBoxLike } | null;
}

let sessions = 0;

/** A fresh draft for a new feature: a spring, as a point, the old editor's start. */
export function startFeatureDraft(): FeatureDraft {
  return {
    session: ++sessions,
    target: { kind: 'new' },
    way: 'point',
    type: 'spring_current',
    note: '',
    radius: String(DEFAULT_FEATURE_RADIUS_M),
    band: String(DEFAULT_FEATURE_BAND_M),
    paste: '',
    geometry: null,
    refusal: null,
    unavailable: false,
    focus: null,
  };
}

/** The redraw target for a stored feature: its own way and shape, or an outline from nothing. */
export function redrawTarget(
  feature: { _id: string; type: string; bbox?: BBoxLike | undefined } & StoredFeatureShape,
): Extract<FeatureTarget, { kind: 'redraw' }> {
  const g = feature.geometry as Geometry | null;
  const label = BODY_FEATURE_TYPE_LABELS[feature.type as BodyFeatureType] ?? feature.type;
  const common = {
    kind: 'redraw' as const,
    featureId: feature._id,
    label,
    bbox: feature.bbox ?? null,
  };
  if (feature.geometryKind === 'point_radius' && g?.type === 'Point') {
    return {
      ...common,
      way: 'point',
      geometry: g,
      multi: false,
      ...(feature.radiusMeters !== undefined ? { radiusMeters: feature.radiusMeters } : {}),
    };
  }
  if (feature.geometryKind === 'line' && g?.type === 'LineString') {
    return {
      ...common,
      way: 'line',
      geometry: g,
      multi: false,
      ...(feature.bufferMeters !== undefined ? { bufferMeters: feature.bufferMeters } : {}),
    };
  }
  return {
    ...common,
    way: 'polygon',
    // Only a single ring can be handed to the vertex editor; a feature in parts is traced anew.
    geometry: g?.type === 'Polygon' ? g : null,
    multi: g?.type === 'MultiPolygon',
    ...(feature.bufferMeters !== undefined ? { bufferMeters: feature.bufferMeters } : {}),
  };
}

/** A redraw: the feature's own way and shape, its radius or band, framed on its box. */
export function startRedrawDraft(target: Extract<FeatureTarget, { kind: 'redraw' }>): FeatureDraft {
  const fresh = startFeatureDraft();
  return {
    ...fresh,
    target,
    way: target.way,
    geometry: target.geometry,
    radius: String(target.radiusMeters ?? DEFAULT_FEATURE_RADIUS_M),
    band: String(target.bufferMeters ?? DEFAULT_FEATURE_BAND_M),
    focus: target.bbox !== null ? { bbox: target.bbox } : null,
  };
}

/** Another way: the shape starts over (the engine is re-attached), the fields stay. */
export function withWay(draft: FeatureDraft, way: FeatureWay): FeatureDraft {
  if (way === draft.way || !FEATURE_WAYS.includes(way)) return draft;
  const t = draft.target;
  // Back to a redrawn feature's own way: its shape again, to edit, not an empty map.
  const own = t.kind === 'redraw' && t.way === way ? t.geometry : null;
  return {
    ...draft,
    session: ++sessions,
    way,
    paste: '',
    geometry: own,
    refusal: null,
    focus: null,
  };
}

/** The point engine's pick: the mark is here now. */
export function withPoint(draft: FeatureDraft, at: LatLng): FeatureDraft {
  return { ...draft, geometry: { type: 'Point', coordinates: [at.lng, at.lat] } };
}

/** The line or ring engine's change: the traced shape, or nothing once it was removed. */
export function withTraced(
  draft: FeatureDraft,
  shape: GeoJSON.LineString | GeoJSON.Polygon | null,
): FeatureDraft {
  return { ...draft, geometry: shape };
}

/** The paste box's text, parsed as it is typed: an outline or a line, or why it is neither. */
export function withPaste(draft: FeatureDraft, paste: string): FeatureDraft {
  if (paste.trim() === '') return { ...draft, paste, geometry: null, refusal: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(paste);
  } catch {
    return { ...draft, paste, geometry: null, refusal: 'That isn’t valid JSON.' };
  }
  const g = unwrapGeometry(parsed);
  if (g === null)
    return { ...draft, paste, geometry: null, refusal: 'There’s no geometry in that.' };
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon' && g.type !== 'LineString') {
    return {
      ...draft,
      paste,
      geometry: null,
      refusal: `A known feature is pasted as a Polygon, a MultiPolygon or a LineString, not a ${g.type}.`,
    };
  }
  return { ...draft, paste, geometry: g, refusal: null };
}

/** The shape's kind as saved: a pasted line is a line, any other paste an outline. */
function kindOf(draft: FeatureDraft): HazardShape['geometryKind'] {
  if (draft.way === 'point') return 'point_radius';
  if (draft.way === 'line') return 'line';
  if (draft.way === 'paste' && draft.geometry?.type === 'LineString') return 'line';
  return 'polygon';
}

/** Which size the shape takes: a point's radius, a line's band, or none (an outline). */
export function sizeField(draft: FeatureDraft): 'radius' | 'band' | null {
  const kind = kindOf(draft);
  return kind === 'point_radius' ? 'radius' : kind === 'line' ? 'band' : null;
}

/** A typed size in meters, or `null` when it isn't one the task takes. */
export function sizeOf(typed: string): number | null {
  if (typed.trim() === '') return null;
  const m = Number(typed);
  return Number.isFinite(m) && m >= FEATURE_SIZE_MIN_M && m <= FEATURE_SIZE_MAX_M ? m : null;
}

/**
 * The shape the save sends, as `bodyFeatures.create` and `updateShape` take it — or `null` while
 * nothing is drawn or the size isn't one. A redrawn outline keeps the band it had.
 */
export function featureShape(draft: FeatureDraft): HazardShape | null {
  const g = draft.geometry;
  if (g === null) return null;
  const kind = kindOf(draft);
  if (kind === 'point_radius') {
    const radiusMeters = sizeOf(draft.radius);
    return radiusMeters === null || g.type !== 'Point'
      ? null
      : { geometryKind: kind, geometry: g, radiusMeters };
  }
  if (kind === 'line') {
    const bufferMeters = sizeOf(draft.band);
    return bufferMeters === null ? null : { geometryKind: kind, geometry: g, bufferMeters };
  }
  const t = draft.target;
  const kept = t.kind === 'redraw' && t.way === 'polygon' ? t.bufferMeters : undefined;
  return { geometryKind: kind, geometry: g, ...(kept !== undefined ? { bufferMeters: kept } : {}) };
}

/** How many positions a geometry holds, every ring and line counted (the server's count). */
function positions(coords: unknown): number {
  if (!Array.isArray(coords)) return 0;
  if (coords.length > 0 && typeof coords[0] === 'number') return 1;
  return coords.reduce((n: number, c) => n + positions(c), 0);
}

const SIZE_WORDS = `${FEATURE_SIZE_MIN_M} to ${FEATURE_SIZE_MAX_M.toLocaleString('en-US')} m`;

/** Whether the draft can be saved now, or the one thing it still needs. */
export function saveBlocker(draft: FeatureDraft): string | null {
  // Why the paste won't do comes before what is still missing.
  if (draft.refusal !== null) return draft.refusal;
  const g = draft.geometry;
  if (g === null) {
    if (draft.way === 'point') return 'The point isn’t placed yet';
    return draft.way === 'paste' ? 'Nothing pasted yet' : 'Nothing drawn yet';
  }
  const size = sizeField(draft);
  if (size === 'radius' && sizeOf(draft.radius) === null) return `The radius is ${SIZE_WORDS}`;
  if (size === 'band' && sizeOf(draft.band) === null) return `The band is ${SIZE_WORDS}`;
  if (positions(g.coordinates) > HAZARD_MAX_VERTICES) {
    return `A known feature is at most ${HAZARD_MAX_VERTICES} points`;
  }
  const shape = featureShape(draft);
  if (shape === null || !isValidHazardShape(shape)) {
    return kindOf(draft) === 'line'
      ? 'A line needs two different points'
      : 'An outline needs three corners and can’t cross itself';
  }
  return null;
}

/**
 * What the map draws under the engine: the footprint the save would store (a point's circle, a
 * line's band, an outline as it is), or — while the shape can't be saved yet — the bare geometry
 * (a point as a hollow ring, the line as traced).
 */
export function featurePreview(draft: FeatureDraft): GeoJSON.Geometry | null {
  if (draft.geometry === null) return null;
  const shape = featureShape(draft);
  if (shape === null || saveBlocker(draft) !== null) return draft.geometry;
  try {
    return hazardFootprint(shape);
  } catch {
    return draft.geometry;
  }
}

/** What the mode bar says: the mode, and what to do next. */
export function featureModeBar(draft: FeatureDraft): { mode: string; line: string } {
  const mode = draft.target.kind === 'redraw' ? 'Redraw' : 'Feature mode';
  const drawn = draft.geometry !== null;
  switch (draft.way) {
    case 'point':
      return {
        mode,
        line: drawn ? 'Drag the mark, or click somewhere else, to move it.' : 'Click where it is.',
      };
    case 'line':
      if (draft.unavailable)
        return { mode, line: 'The draw tool couldn’t load. Paste the line instead.' };
      return {
        mode,
        line: drawn
          ? 'Drag a point to move it, or the middle of a stretch to add one.'
          : 'Click along it, and click the last point again to end the line.',
      };
    case 'polygon':
      if (draft.unavailable)
        return { mode, line: 'The draw tool couldn’t load. Paste the outline instead.' };
      return {
        mode,
        line: drawn
          ? 'Drag a point to move it, or the middle of an edge to add one.'
          : 'Click around it, and click the first point again to close it.',
      };
    case 'paste':
      return {
        mode,
        line: drawn ? 'The pasted shape, as it will be saved.' : 'Paste a shape in the panel.',
      };
  }
}

/** The task's header: what this drawing is for. */
export function featureTaskHeading(draft: FeatureDraft): string {
  return draft.target.kind === 'redraw' ? `Redraw · ${draft.target.label}` : 'New known feature';
}

/** The task's line under the header, when it has something to say. */
export function featureTaskNote(draft: FeatureDraft): string | null {
  const t = draft.target;
  if (t.kind === 'new') {
    return 'It shows every winter, without fading, until someone demotes it.';
  }
  if (t.multi && draft.way === 'polygon') {
    return 'This one is stored in several parts, which can’t be edited here. Draw it again as one outline, or paste the parts.';
  }
  return 'The new shape replaces the old one.';
}

/** The audit row's reason, written for the moderator (the old editor's words). */
export function featureReason(draft: FeatureDraft): string {
  return draft.target.kind === 'redraw'
    ? `Redrawn by hand: ${draft.target.label}.`
    : `Authored by hand: ${BODY_FEATURE_TYPE_LABELS[draft.type]}.`;
}

/** The receipt's words once the save lands. */
export function featureSavedTitle(draft: FeatureDraft): string {
  return draft.target.kind === 'redraw'
    ? `Shape redrawn · ${draft.target.label}`
    : `Known feature added · ${BODY_FEATURE_TYPE_LABELS[draft.type]}`;
}
