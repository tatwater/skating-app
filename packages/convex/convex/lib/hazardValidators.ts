/**
 * Hazard validators shared by the schema and the mutation args, so a hazard's type/primitive vocabulary
 * is declared once and can never drift between what the table accepts and what the API accepts.
 */

import { HAZARD_TYPES } from '@skating/core';
import { HAZARD_GEOMETRY_KINDS } from './enums';
import { literals } from './validators';

export { HAZARD_GEOMETRY_KINDS };

/** Exactly one hazard type (D51/D52 — see the note on `hazards.type` in the schema). */
export const HAZARD_TYPES_VALIDATOR = literals(HAZARD_TYPES);
