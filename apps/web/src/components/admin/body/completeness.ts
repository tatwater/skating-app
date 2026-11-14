import { COMPLETENESS_FIELDS, type CompletenessField } from '@skating/core';

import type { LedSegment } from '@/components/kit/trace-chart';
import { listWords } from '@/lib/words';

/**
 * **How complete a body's record is, as the pages draw it.** The rule is core's
 * (`bodyCompleteness`: the founder's ten, Review 13 — outline, name, access, depth, elevation, wind,
 * put-ins, lots, landmarks, bathymetry) and the server stores its answer on every library row
 * (`have`, `of`, `missing`). A page displays that answer — it never decides it again — so this
 * module holds only what the rule doesn't say: each field's words and the strip's segments.
 */

export type { CompletenessField };

/** A body's completeness as core states it: how many it has, of how many, and which it lacks. */
export interface Completeness {
  have: number;
  of: number;
  missing: readonly CompletenessField[];
}

/** Each field in the note's words: "Missing bathymetry, a lot and a landmark". */
export const COMPLETENESS_WORDS: Record<CompletenessField, string> = {
  outline: 'an outline',
  name: 'a name',
  access: 'access',
  depth: 'depth',
  elevation: 'elevation',
  wind: 'wind',
  putIns: 'a put-in',
  lots: 'a lot',
  landmarks: 'a landmark',
  bathymetry: 'bathymetry',
};

/** The strip's segments, in core's order: lit for what the body has, dark for what it lacks. */
export function completenessSegments(c: Completeness): LedSegment[] {
  return COMPLETENESS_FIELDS.slice(0, c.of).map((field) =>
    c.missing.includes(field) ? 'off' : 'on',
  );
}

/** "Missing bathymetry", "Missing depth and bathymetry", "Missing wind, depth and bathymetry". */
export function missingSentence(missing: readonly CompletenessField[]): string | null {
  if (missing.length === 0) return null;
  return `Missing ${listWords(missing.map((f) => COMPLETENESS_WORDS[f]))}`;
}
