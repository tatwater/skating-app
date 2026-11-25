/**
 * **What raised an intake question, as evidence a settle can be held to** (B01-6a, D305).
 *
 * PLACEHOLDER (S1's): the T0 stub. Its signatures are the briefs' canonical snippet; S1 replaces
 * the bodies (and this paragraph) with the rule, its Vitest cases and its `fast-check` property.
 */

import type { ReviewReason } from './confidence';

/** The stored facts the evidence is read from: the body's catalog claims. */
export type EvidenceRecord = {
  nameClaims?: readonly { source: string; value: string; sources?: readonly string[] }[];
  classClaims?: readonly { source: string; value: string; token?: string }[];
};

/** Evidence over facts not yet stored (no class claims). */
export const UNRECORDED_EVIDENCE = 'unrecorded';

/**
 * What raised `reason` on `record`, as a deterministic string (at most 1 KiB). A name conflict's:
 * the distinct catalog spellings only (never a `user` claim) — their normalized keys, sorted — and
 * never which catalogs publish them, so the campaign that first records `sources`, or a catalog
 * newly agreeing with a spelling already there, re-asks nothing; a new spelling, or one withdrawn,
 * does. A class conflict's: its claims with their tokens. `null` for a reason 6a doesn't settle
 * (`class-dissent` included: 6b adds the refusals, D306). One rule for the settle and the import
 * (D305).
 */
export function reviewEvidence(_reason: ReviewReason, _record: EvidenceRecord): string | null {
  throw new Error('PLACEHOLDER (S1): reviewEvidence is not built yet');
}
