/**
 * The hazard *authoring* state machine (D51) — what a half-drawn hazard is, and every transition a
 * capture UI can apply to it.
 *
 * This exists as pure logic rather than component state for the reason the polyline commit exists at
 * all: web draws with a mouse and mobile draws with a gloved thumb, but the thing being drawn — and
 * especially the rules for *when it becomes valid* — must be identical. A ridge captured on the ice
 * and the same ridge drawn at a laptop have to produce the same row, or the footprint a skater sees
 * stops being the footprint the proximity evaluator measures.
 *
 * Two states are deliberately representable and deliberately *not* submittable: a point draft with no
 * centre yet, and a line draft with fewer than two distinct vertices. A polyline is captured one tap
 * at a time, so "half a line" is a normal intermediate — it must be a value the UI can hold and
 * render, and `isDraftSubmittable` is the single gate that decides it can't be stored yet.
 * (`isValidHazardShape` remains the authority; this module never re-implements that judgement.)
 */

import type { LatLng } from './geometry';
import {
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_GEOMETRY_KIND,
  HAZARD_DEFAULT_RADIUS_M,
  type HazardShape,
  isValidHazardShape,
  lineShape,
  pointRadiusShape,
} from './hazardGeometry';
import type { HazardType } from './types';

/**
 * The primitives a person can actually *draw* in v1 (D51 build staging, call 5).
 *
 * Freeform polygon is missing on purpose: it renders and it stores, but authoring it needs vertex
 * dragging and self-intersection handling, and D51 already calls it the opt-in/advanced primitive.
 */
export type HazardAuthorableKind = 'point_radius' | 'line';

/** A hazard mid-capture. `coord: null` / `vertices: []` are the legitimate "not placed yet" states. */
export type HazardDraft =
  | { geometryKind: 'point_radius'; coord: LatLng | null; radiusMeters: number }
  | { geometryKind: 'line'; vertices: LatLng[]; bufferMeters: number };

/**
 * The size ladders, in metres. Coarse and non-linear on purpose: this is an eyeball estimate of
 * something on a lake, not a survey (D3), and a short ladder is what makes the control a pair of
 * −/+ buttons rather than a slider — sliders are miserable with gloves on.
 */
export const HAZARD_RADIUS_STEPS_M = [5, 10, 25, 50, 100, 200, 400] as const;

/**
 * The uncertainty half-width ladder for linear hazards. It bottoms out lower and tops out far lower
 * than the radius ladder: a wide band on a polyline covers a *lot* of ice, and a ridge drawn 400 m
 * wide would swallow the lake rather than describe the hazard.
 */
export const HAZARD_BUFFER_STEPS_M = [2, 4, 8, 15, 25, 40, 60] as const;

/** Move `current` to the neighbouring rung, clamping at the ends. Off-ladder values snap inward. */
export function stepSize(current: number, steps: readonly number[], direction: 1 | -1): number {
  if (steps.length === 0) return current;
  if (direction === 1) return steps.find((s) => s > current) ?? Math.max(...steps, current);
  return [...steps].reverse().find((s) => s < current) ?? Math.min(...steps, current);
}

/**
 * The draft a freshly-picked type starts in: its natural primitive at its own default size.
 *
 * A ridge, a heave and a working crack are lines in reality, so they start as lines — that is the
 * whole D51 thesis (draw the shape the thing actually is, which is also the shape a human can
 * produce accurately). Everything else starts as a circle awaiting a centre.
 */
export function draftForType(type: HazardType): HazardDraft {
  return HAZARD_DEFAULT_GEOMETRY_KIND[type] === 'line'
    ? { geometryKind: 'line', vertices: [], bufferMeters: HAZARD_DEFAULT_BUFFER_M[type] }
    : pointDraftForType(type);
}

/**
 * A starting draft that is **always** a circle, whatever the type's natural primitive — the on-ice
 * capture path (D51/§Mobile).
 *
 * On the ice the rule that wins is "the hazard is committable after two taps": a mitten-fumble that
 * hits Done early must still produce a useful pin. A line can't satisfy that, because one GPS fix is
 * one vertex and a one-vertex line isn't storable. So a ridge flagged from the ice starts as a circle
 * at the skater's position and *upgrades* to a polyline via `switchDraftKind` if they choose to trace
 * it. Web, where there's a mouse and no cold, starts linear types linear.
 */
export function pointDraftForType(type: HazardType): HazardDraft {
  return { geometryKind: 'point_radius', coord: null, radiusMeters: HAZARD_DEFAULT_RADIUS_M[type] };
}

/**
 * Switch primitive without losing the work already done.
 *
 * Both directions stay open regardless of the type's default, because both real cases happen: you
 * see a ridge but only know the one spot you're standing at (line → point), or you started marking
 * open water and realise it's a lead running across the bay (point → line). Converting keeps the
 * placement and swaps in the type's default size for the new primitive, since a 400 m radius and a
 * 400 m half-width mean very different things.
 */
export function switchDraftKind(
  draft: HazardDraft,
  kind: HazardAuthorableKind,
  type: HazardType,
): HazardDraft {
  if (draft.geometryKind === kind) return draft;
  if (draft.geometryKind === 'point_radius') {
    return {
      geometryKind: 'line',
      vertices: draft.coord ? [draft.coord] : [],
      bufferMeters: HAZARD_DEFAULT_BUFFER_M[type],
    };
  }
  return {
    geometryKind: 'point_radius',
    // The first vertex, not the last: it's where the person started describing the hazard, and it
    // survives an undo of everything after it.
    coord: draft.vertices[0] ?? null,
    radiusMeters: HAZARD_DEFAULT_RADIUS_M[type],
  };
}

/** Re-type an in-progress draft: keep the placement, adopt the new type's default size. */
export function retypeDraft(draft: HazardDraft, type: HazardType): HazardDraft {
  const kind: HazardAuthorableKind =
    HAZARD_DEFAULT_GEOMETRY_KIND[type] === 'line' ? 'line' : 'point_radius';
  // `switchDraftKind` handles the size swap when the primitive changes; when it doesn't, the size
  // still has to follow the new type (a drilled hole and a thaw-rotten zone are 5 m vs 60 m).
  const switched = switchDraftKind(draft, kind, type);
  if (switched !== draft) return switched;
  return draft.geometryKind === 'line'
    ? { ...draft, bufferMeters: HAZARD_DEFAULT_BUFFER_M[type] }
    : { ...draft, radiusMeters: HAZARD_DEFAULT_RADIUS_M[type] };
}

/**
 * A map tap. One entry point for both primitives, so the capture UI arms "drop mode" once and does
 * not branch: a circle takes the tap as its centre (and a second tap *moves* it), a line appends.
 */
export function applyDraftMapClick(draft: HazardDraft, coord: LatLng): HazardDraft {
  return draft.geometryKind === 'point_radius'
    ? { ...draft, coord }
    : { ...draft, vertices: [...draft.vertices, coord] };
}

/**
 * Undo the last placement. On a line this drops the last vertex; on a circle it clears the centre,
 * which is the same promise — one step back, never a full reset of the size you already tuned.
 */
export function undoDraftPlacement(draft: HazardDraft): HazardDraft {
  return draft.geometryKind === 'point_radius'
    ? { ...draft, coord: null }
    : { ...draft, vertices: draft.vertices.slice(0, -1) };
}

/** −/+ on whichever size the current primitive uses. */
export function resizeDraft(draft: HazardDraft, direction: 1 | -1): HazardDraft {
  return draft.geometryKind === 'point_radius'
    ? { ...draft, radiusMeters: stepSize(draft.radiusMeters, HAZARD_RADIUS_STEPS_M, direction) }
    : { ...draft, bufferMeters: stepSize(draft.bufferMeters, HAZARD_BUFFER_STEPS_M, direction) };
}

/** How many placements the draft holds — what the "2 points" counter on the drawing bar shows. */
export function draftPlacementCount(draft: HazardDraft): number {
  return draft.geometryKind === 'point_radius' ? (draft.coord ? 1 : 0) : draft.vertices.length;
}

/** The vertices to render as dots while drawing, so a tap you can't yet see a shape from still lands. */
export function draftVertices(draft: HazardDraft): LatLng[] {
  return draft.geometryKind === 'point_radius'
    ? draft.coord
      ? [draft.coord]
      : []
    : draft.vertices;
}

/**
 * The storable shape, or `null` while the draft is still incomplete.
 *
 * Everything downstream — the live footprint on the map, the submit button's enabled state, the
 * mutation args — goes through this one function, so there is exactly one definition of "done
 * enough" and the preview can never show a shape the server would reject.
 */
export function draftToShape(draft: HazardDraft): HazardShape | null {
  const shape =
    draft.geometryKind === 'point_radius'
      ? draft.coord
        ? pointRadiusShape(draft.coord, draft.radiusMeters)
        : null
      : lineShape(draft.vertices, draft.bufferMeters);
  if (!shape || !isValidHazardShape(shape)) return null;
  return shape;
}

/** Can this draft be posted yet? */
export function isDraftSubmittable(draft: HazardDraft): boolean {
  return draftToShape(draft) !== null;
}
