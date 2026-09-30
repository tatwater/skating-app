/**
 * Landmarks in an extraction's `where`s (D202) — one pass over either engine's result, so both name
 * landmarks the same way. Two jobs, per report, against its body's candidate landmarks:
 *
 * - **An id the engine gave must be one of this body's candidates.** A model that copies an id from
 *   the wrong line, or invents one, would otherwise hand the sheet a `landmarkId` the server refuses
 *   — the whole Post with it. An unknown id is dropped; the place name stays.
 * - **A place the engine named resolves by spelling** (`landmarkNamedIn`): "a wind hole off
 *   Shelburne Point" becomes Shelburne Point's id whether the engine gave one or not. Stage B's
 *   places arrive as names only, and the prompt carries only a body's most prominent landmarks.
 *
 * A report with no body (`bodyRef: null`) is left as it is — there are no landmarks to be.
 */

import { landmarkNamedIn } from '@skating/core';
import type { ExtractedWhere, ExtractionInput, ExtractionResult } from './contract';

type Located = { where?: ExtractedWhere | undefined };

function locatedValues(fields: ExtractionResult['reports'][number]['fields']): Located[] {
  return [
    ...fields.sightings.map((f) => f.value),
    ...fields.iceTypes.map((f) => f.value),
    ...fields.surfaceTags.map((f) => f.value),
    ...fields.thickness.map((f) => f.value),
    ...fields.hazards.map((f) => f.value),
  ];
}

export function attachLandmarks(
  result: ExtractionResult,
  input: ExtractionInput,
): ExtractionResult {
  const byRef = new Map(input.bodyCandidates.map((b) => [b.ref, b.landmarks ?? []]));
  for (const report of result.reports) {
    const landmarks = report.bodyRef === null ? [] : (byRef.get(report.bodyRef) ?? []);
    const ids = new Set(landmarks.map((l) => l.id));
    for (const value of locatedValues(report.fields)) {
      const where = value.where;
      if (!where) continue;
      if (where.landmarkId !== undefined && !ids.has(where.landmarkId)) delete where.landmarkId;
      if (where.landmarkId === undefined && where.placeName !== undefined) {
        const named = landmarkNamedIn(where.placeName, landmarks);
        if (named) where.landmarkId = named.id;
      }
    }
  }
  return result;
}
