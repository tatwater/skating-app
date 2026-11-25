import { DEFAULT_SAMPLE_SPACING_KM, type LatLng, suggestSamplePoints } from '@skating/core';

import type { BBoxLike } from '@/lib/mapSurface';

/**
 * **A suggested grid of weather sample points** (B01-6b, D300): the old editor's tool, kept as it
 * was — suggest a grid at a spacing, look at it on the map, save it or let it go. Pure but for the
 * session counter: the Water tab keeps it in state, and the map's claim is read off it (no engine;
 * the grid is the draft, drawn as hollow rings — proposed, not placed).
 *
 * - **The grid is core's** (`suggestSamplePoints`), from the outline the page already has: only
 *   points on the water, never none (a grid that misses the water falls back to one point, and
 *   says so), capped and saying so.
 * - **The save is a compare-and-set**: it carries the points the suggestion was made over
 *   (`expected`), and the server refuses it if they moved meanwhile.
 */

/** The narrowest spacing the task takes, in km: below the forecast models' own cells. */
export const SAMPLE_SPACING_MIN_KM = 1;
/** The widest: past it, any body this side of a sea gets one point. */
export const SAMPLE_SPACING_MAX_KM = 100;

export interface SampleDraft {
  /** A new value starts the map's preview over (the tool claim's session). */
  session: number;
  /** As typed, in km. */
  spacing: string;
  /** The grid as last suggested, and the spacing it was suggested at. */
  points: LatLng[];
  km: number;
  truncated: boolean;
  fellBack: boolean;
  /** The points stored when the task opened: what the save expects to replace. */
  expected: LatLng[];
  /** The body's box, framed as the preview starts. */
  focus: { bbox: BBoxLike } | null;
}

let sessions = 0;

/** A typed spacing in km, or `null` when it isn't one the task takes. */
export function spacingOf(typed: string): number | null {
  if (typed.trim() === '') return null;
  const km = Number(typed);
  return Number.isFinite(km) && km >= SAMPLE_SPACING_MIN_KM && km <= SAMPLE_SPACING_MAX_KM
    ? km
    : null;
}

/** The task opened: a grid at the default spacing over the outline. */
export function startSampleDraft(
  outline: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  stored: readonly LatLng[],
  box: BBoxLike | null,
): SampleDraft {
  return suggest(
    {
      session: 0,
      spacing: String(DEFAULT_SAMPLE_SPACING_KM),
      points: [],
      km: DEFAULT_SAMPLE_SPACING_KM,
      truncated: false,
      fellBack: false,
      expected: stored.map((p) => ({ lat: p.lat, lng: p.lng })),
      focus: box !== null ? { bbox: box } : null,
    },
    outline,
  );
}

/** A grid at the draft's spacing, or the draft as it was when the spacing isn't one. */
export function suggest(
  draft: SampleDraft,
  outline: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): SampleDraft {
  const km = spacingOf(draft.spacing);
  if (km === null) return draft;
  const s = suggestSamplePoints(outline, km);
  return {
    ...draft,
    session: ++sessions,
    points: s.points,
    km,
    // The camera frames the body once, as the task opens; a grid suggested again keeps the view.
    focus: draft.session === 0 ? draft.focus : null,
    truncated: s.truncated,
    fellBack: s.fellBackToCentroid,
  };
}

/** The grid as the map draws it: hollow rings. */
export function sampleGeometry(draft: SampleDraft): GeoJSON.MultiPoint {
  return { type: 'MultiPoint', coordinates: draft.points.map((p) => [p.lng, p.lat]) };
}

const plural = (n: number) => `${n} point${n === 1 ? '' : 's'}`;

/** What the grid is, in a sentence: how many, and whether it fell back or was cut short. */
export function sampleSummary(draft: SampleDraft): string {
  if (draft.fellBack) {
    return 'No grid point landed on the water at that spacing, so this is one point, inside the water near its middle.';
  }
  if (draft.truncated) {
    return `${plural(draft.points.length)}, the most a body can carry. A wider spacing covers the rest.`;
  }
  return `${plural(draft.points.length)} on the water, ${draft.km} km apart.`;
}

/** Why the spacing field holds back a new grid, or `null`. */
export function spacingBlocker(draft: SampleDraft): string | null {
  return spacingOf(draft.spacing) === null
    ? `The spacing is ${SAMPLE_SPACING_MIN_KM} to ${SAMPLE_SPACING_MAX_KM} km`
    : null;
}

/** The mode bar while the grid is shown. */
export function sampleModeBar(draft: SampleDraft): { mode: string; line: string } {
  return {
    mode: 'Sample points',
    line:
      draft.points.length === 1
        ? 'The hollow ring is the suggestion. Save it to sample there.'
        : 'The hollow rings are the suggestion. Save them to sample there.',
  };
}

/** The receipt's words once the save lands. */
export function sampleSavedTitle(points: readonly LatLng[]): string {
  return points.length === 0 ? 'Sample points cleared' : `Sample points set · ${points.length}`;
}
