import {
  deriveShoreBand,
  draftForType,
  draftPlacementCount,
  draftToShape,
  HAZARD_BUFFER_STEPS_M,
  HAZARD_DEFAULT_BUFFER_M,
  type HazardAuthorableKind,
  type HazardShape,
  type HazardDraft as HazardShapeDraft,
  type HazardType,
  type LatLng,
  metersToFeet,
  offersShoreBand,
  resizeDraft as resizeShapeDraft,
  retypeDraft,
  SHORE_BAND_DEFAULT_HALF_WIDTH_M,
  stepSize,
  switchDraftKind,
  undoDraftPlacement,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

import type {
  HazardDraft,
  HazardDrawKind,
  HazardFlowStep,
  ShorePick,
} from '@/stores/hazardDraftStore';
import { EMPTY_HAZARD_DRAFT } from '@/stores/hazardDraftStore';

import type { MapMode } from '../map/mapSpec';

/**
 * The hazard flow's rules (boards 3.1–3.8), pure — so the order of the screen, what a click on the
 * map does and when Post wakes up are testable without Convex, React or WebGL. The geometry is
 * `@skating/core`'s draft state machine (shared with mobile); this module only adds the web flow's
 * four ways to draw and the shore pick around it.
 *
 * Nothing here judges the ice (D3): the flow records what a person saw and where, and every size is
 * "about" — an estimate, never a survey.
 */

export type BodyPolygon = Polygon | MultiPolygon;

/** The "Draw it as" chips, in the order they cost effort. Shore is offered only where it fits. */
export const DRAW_KIND_LABELS: Readonly<Record<HazardDrawKind, string>> = {
  spot: 'A spot',
  line: 'A line',
  area: 'An area',
  shore: 'Along the shore',
};

/** The shore chip's tooltip: what the mode does, so the chip can stay two words. */
export const SHORE_TIP = 'Follows the lake’s own outline between two clicks — no tracing.';

const KIND_FOR_DRAW: Readonly<Record<Exclude<HazardDrawKind, 'shore'>, HazardAuthorableKind>> = {
  spot: 'point_radius',
  line: 'line',
  area: 'polygon',
};

/** The chip a core draft corresponds to. */
export function drawKindOf(shape: HazardShapeDraft): Exclude<HazardDrawKind, 'shore'> {
  return shape.geometryKind === 'point_radius'
    ? 'spot'
    : shape.geometryKind === 'line'
      ? 'line'
      : 'area';
}

/** Which chips this type offers: shore only for the two shore-shaped types (A05b Decision 1). */
export function drawKindsFor(type: HazardType | null): HazardDrawKind[] {
  const kinds: HazardDrawKind[] = ['spot', 'line', 'area'];
  if (type !== null && offersShoreBand(type)) kinds.push('shore');
  return kinds;
}

/** A fresh flow on a lake. */
export function startDraft(waterBodyId: string, stackedInReport: boolean): HazardDraft {
  return { ...EMPTY_HAZARD_DRAFT, waterBodyId, stackedInReport };
}

/** The storable shape, or `null` while the draft can't post yet — core's one definition. */
export function shapeOf(draft: HazardDraft): HazardShape | null {
  return draft.shape ? draftToShape(draft.shape) : null;
}

/** Where the screen stands: picked a type? placed it? (`confirm` is raised only by Post.) */
export function stepOf(draft: HazardDraft): HazardFlowStep {
  if (draft.nearbyHazardId !== null) return 'confirm';
  if (draft.hazardType === null) return 'what';
  return shapeOf(draft) === null ? 'where' : 'details';
}

function settle(draft: HazardDraft): HazardDraft {
  return { ...draft, step: stepOf(draft) };
}

function emptyShore(): ShorePick {
  return {
    taps: [],
    halfWidthMeters: SHORE_BAND_DEFAULT_HALF_WIDTH_M,
    theOtherWay: false,
    refusal: null,
    arcLengthMeters: null,
  };
}

/**
 * What you saw (3.1). Re-typing keeps whatever was placed and adopts the new type's primitive and
 * size (core's `retypeDraft`) — except a shore band, which was derived *for* a shore-shaped type and
 * starts over, so a pressure ridge never ends up shaped exactly like a shoreline. Nothing placed yet
 * ⇒ the map starts listening at once.
 */
export function chooseType(draft: HazardDraft, type: HazardType): HazardDraft {
  const keep = draft.shape !== null && draft.drawKind !== 'shore';
  const shape = keep && draft.shape ? retypeDraft(draft.shape, type) : draftForType(type);
  return settle({
    ...draft,
    hazardType: type,
    shape,
    drawKind: drawKindOf(shape),
    shore: null,
    placing: draftPlacementCount(shape) === 0,
    // Matching is per type family, so a "different hazard" answer doesn't carry across a retype.
    nearbyHazardId: null,
    dismissedDuplicateOf: null,
  });
}

/**
 * The × on the chosen type (3.2–3.7): back to every type, the map stops listening. What was placed
 * stays, so picking the right type is one click, not a redraw.
 */
export function clearType(draft: HazardDraft): HazardDraft {
  return settle({
    ...draft,
    hazardType: null,
    placing: false,
    nearbyHazardId: null,
    dismissedDuplicateOf: null,
  });
}

/**
 * A "Draw it as" chip (3.2–3.6) — a click, which is also how a sub-mode is left. The chip already
 * on re-arms the map ("Move on map", "Keep tracing"); another chip switches primitive without losing
 * the work (core's `switchDraftKind`). Shore starts a fresh pick: two clicks near the shore.
 */
export function chooseDrawKind(draft: HazardDraft, kind: HazardDrawKind): HazardDraft {
  const type = draft.hazardType;
  if (type === null) return draft;
  if (kind === 'shore') {
    if (!offersShoreBand(type)) return draft;
    return settle({
      ...draft,
      drawKind: 'shore',
      shore: emptyShore(),
      shape: { geometryKind: 'polygon', vertices: [], bufferMeters: HAZARD_DEFAULT_BUFFER_M[type] },
      placing: true,
    });
  }
  if (draft.drawKind === kind && draft.shape !== null) {
    return { ...draft, placing: true };
  }
  const from =
    draft.shape === null || draft.drawKind === 'shore' ? draftForType(type) : draft.shape;
  const shape = switchDraftKind(from, KIND_FOR_DRAW[kind], type);
  return settle({ ...draft, drawKind: kind, shape, shore: null, placing: true });
}

/** Leaves the sub-mode by a click (Done). The shape stays as drawn. */
export function stopPlacing(draft: HazardDraft): HazardDraft {
  return { ...draft, placing: false };
}

/**
 * Re-derives the band from the pick. Refusals are kept on the pick with the shape emptied, so Post
 * can't send a band that was refused — and the width stepper stays live, since narrowing is the way
 * out of the commonest refusal.
 */
export function deriveShore(draft: HazardDraft, polygon: BodyPolygon | null): HazardDraft {
  const shore = draft.shore;
  const type = draft.hazardType;
  if (shore === null || type === null || shore.taps.length < 2) return draft;
  const buffer = HAZARD_DEFAULT_BUFFER_M[type];
  const [a, b] = shore.taps as [LatLng, LatLng];
  const result = polygon
    ? deriveShoreBand(polygon, a, b, {
        halfWidthMeters: shore.halfWidthMeters,
        theOtherWay: shore.theOtherWay,
      })
    : ({ ok: false, reason: 'no_boundary' } as const);
  if (!result.ok) {
    return settle({
      ...draft,
      shore: { ...shore, refusal: result.reason, arcLengthMeters: null },
      shape: { geometryKind: 'polygon', vertices: [], bufferMeters: buffer },
    });
  }
  return settle({
    ...draft,
    shore: { ...shore, refusal: null, arcLengthMeters: result.band.arcLengthMeters },
    shape: { geometryKind: 'polygon', vertices: result.band.vertices, bufferMeters: buffer },
  });
}

/**
 * A click on the map while placing. A spot takes the click and the mode ends (a sub-mode is left by
 * a click); a line appends and keeps listening until Done; an area belongs to terra-draw, so a map
 * click is ignored here; the shore takes two clicks, then derives and stops.
 */
export function applyMapClick(
  draft: HazardDraft,
  coord: LatLng,
  polygon: BodyPolygon | null,
): HazardDraft {
  if (!draft.placing || draft.shape === null || draft.hazardType === null) return draft;
  if (draft.drawKind === 'shore' && draft.shore) {
    const taps = draft.shore.taps.length >= 2 ? [coord] : [...draft.shore.taps, coord];
    const next = { ...draft, shore: { ...draft.shore, taps, refusal: null } };
    if (taps.length < 2) return next;
    return deriveShore({ ...next, placing: false }, polygon);
  }
  if (draft.shape.geometryKind === 'point_radius') {
    return settle({ ...draft, shape: { ...draft.shape, coord }, placing: false });
  }
  if (draft.shape.geometryKind === 'line') {
    return settle({
      ...draft,
      shape: { ...draft.shape, vertices: [...draft.shape.vertices, coord] },
    });
  }
  return draft;
}

/** The area tool's ring changed (a finish, or a corner dragged). Distinct corners, unclosed. */
export function applyAreaRing(draft: HazardDraft, ring: LatLng[] | null): HazardDraft {
  if (draft.shape?.geometryKind !== 'polygon' || draft.drawKind !== 'area') return draft;
  return settle({ ...draft, shape: { ...draft.shape, vertices: ring ?? [] } });
}

/** "Undo point" on a line, "Clear" on a spot — one step back, never a full reset. */
export function undoPlacement(draft: HazardDraft): HazardDraft {
  if (draft.shape === null || draft.drawKind === 'shore' || draft.drawKind === 'area') return draft;
  return settle({ ...draft, shape: undoDraftPlacement(draft.shape) });
}

/** "Long way around" ↔ "Shortest distance" (3.6). */
export function flipShore(draft: HazardDraft, polygon: BodyPolygon | null): HazardDraft {
  if (draft.shore === null) return draft;
  return deriveShore(
    { ...draft, shore: { ...draft.shore, theOtherWay: !draft.shore.theOtherWay } },
    polygon,
  );
}

/** −/+ — the band's half-width while following the shore, else the draft's own size. */
export function resize(draft: HazardDraft, direction: 1 | -1, polygon: BodyPolygon | null) {
  if (draft.drawKind === 'shore' && draft.shore) {
    const halfWidthMeters = stepSize(draft.shore.halfWidthMeters, HAZARD_BUFFER_STEPS_M, direction);
    return deriveShore({ ...draft, shore: { ...draft.shore, halfWidthMeters } }, polygon);
  }
  if (draft.shape === null) return draft;
  return settle({ ...draft, shape: resizeShapeDraft(draft.shape, direction) });
}

// ── Copy ──────────────────────────────────────────────────────────────────────────────────────

/** Feet, rounded the way an eyeball estimate is said out loud (US units everywhere). */
export function aboutFeet(meters: number): string {
  const feet = metersToFeet(meters);
  const rounded = feet < 20 ? Math.round(feet) : Math.round(feet / 5) * 5;
  return rounded.toLocaleString('en-US');
}

/** The shore toggle's words: what the click *does* next (3.6, the founder's call). */
export function shoreToggleLabel(shore: ShorePick): string {
  return shore.theOtherWay ? 'Shortest distance' : 'Long way around';
}

/** "Where is it?" — what's placed so far, as a description rather than a field. */
export function whereLine(draft: HazardDraft): string {
  const shape = draft.shape;
  if (shape === null) return 'Not placed yet.';
  if (draft.drawKind === 'shore' && draft.shore) {
    const { taps, arcLengthMeters } = draft.shore;
    if (arcLengthMeters !== null) {
      return `Following about ${aboutFeet(arcLengthMeters)} ft of shoreline.`;
    }
    return taps.length === 1 ? 'Now click the other end.' : 'Picking a stretch of shore.';
  }
  const n = draftPlacementCount(shape);
  if (n === 0) return 'Not placed yet.';
  if (shape.geometryKind === 'line') {
    return n === 1
      ? 'Traced with 1 point — a line needs at least two.'
      : `Traced with ${n} points.`;
  }
  if (shape.geometryKind === 'polygon') {
    return n < 3
      ? `Drawn with ${n} ${n === 1 ? 'corner' : 'corners'} — an area needs at least three.`
      : `Drawn with ${n} corners.`;
  }
  return 'Placed on the map.';
}

/** The button that re-arms the map once something is placed (3.7, 3.8). */
export function replaceLabel(draft: HazardDraft): string | null {
  if (draft.shape === null || draft.placing) return null;
  if (draft.drawKind === 'shore') return 'Pick a different stretch';
  const n = draftPlacementCount(draft.shape);
  if (draft.drawKind === 'line') return n === 0 ? 'Trace on map' : 'Keep tracing';
  if (draft.drawKind === 'area') return n === 0 ? 'Draw on map' : 'Adjust corners';
  return n === 0 ? 'Place on map' : 'Move on map';
}

export interface SizeCopy {
  question: string;
  value: string;
  tip: string;
  narrower: string;
  wider: string;
}

/** The size stepper's words (3.7). The explanation is a tooltip, not a standing paragraph. */
export function sizeCopy(draft: HazardDraft): SizeCopy | null {
  const shape = draft.shape;
  if (shape === null || draft.hazardType === null) return null;
  if (draft.drawKind === 'shore' && draft.shore) {
    return {
      question: 'How far out from shore?',
      value: `about ${aboutFeet(draft.shore.halfWidthMeters)} ft out from the shoreline`,
      tip: 'An estimate is fine — the band shows roughly how far out the ice is affected, not an exact edge. The part that falls on land is trimmed off.',
      narrower: 'Narrower',
      wider: 'Wider',
    };
  }
  if (shape.geometryKind === 'line') {
    return {
      question: 'Roughly how wide?',
      value: `about ${aboutFeet(shape.bufferMeters)} ft to either side of the line`,
      tip: 'An estimate is fine — the band shows roughly how far the hazard reaches, not an exact edge. A folded pressure ridge is far wider than a hairline crack.',
      narrower: 'Narrower',
      wider: 'Wider',
    };
  }
  return {
    question: 'Roughly how big?',
    value:
      shape.geometryKind === 'polygon'
        ? `about ${aboutFeet(shape.bufferMeters)} ft of give around the edge`
        : `about ${aboutFeet(shape.radiusMeters)} ft around the spot`,
    tip: 'An estimate is fine — the marker is drawn as an approximate area, not an exact edge.',
    narrower: 'Smaller',
    wider: 'Bigger',
  };
}

/** Why Post is asleep, as its tooltip; `null` when it can go. */
export function postBlocker(draft: HazardDraft): string | null {
  if (draft.hazardType === null) return 'Pick what you saw, then place it on the map';
  if (shapeOf(draft) === null) return 'Place it on the map first';
  return null;
}

/**
 * The map's mode bar while it's the input (3.2–3.6): the mode's name, what to do next, and where
 * the drawing stands. `null` when the map isn't listening.
 */
export function mapModeFor(draft: HazardDraft): MapMode | null {
  const mode = placingMode(draft);
  // The bar's exit closes the whole flow (one Esc per screen), so it says what the sheet's own
  // button says: Close.
  return mode === null ? null : { ...mode, exitLabel: 'Close' };
}

function placingMode(draft: HazardDraft): MapMode | null {
  if (!draft.placing || draft.shape === null || draft.hazardType === null) return null;
  const n = draftPlacementCount(draft.shape);
  switch (draft.drawKind) {
    case 'shore': {
      const one = (draft.shore?.taps.length ?? 0) === 1;
      return {
        mode: 'Along the shore',
        line: one ? 'Click the other end' : 'Click one end of the stretch',
        step: one ? '1 of 2' : '0 of 2',
      };
    }
    case 'line':
      return {
        mode: 'Tracing a line',
        line: 'Click along it, then Done',
        step: `${n} ${n === 1 ? 'point' : 'points'}`,
      };
    case 'area':
      return n >= 3
        ? {
            mode: 'Drawing an area',
            line: 'Drag any corner to adjust, then Done',
            step: `${n} corners`,
          }
        : { mode: 'Drawing an area', line: 'Click each corner, then the first one again' };
    default:
      return { mode: 'Placing a spot', line: 'Click where it is' };
  }
}
