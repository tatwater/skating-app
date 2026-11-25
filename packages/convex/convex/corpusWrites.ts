/**
 * **The Corpus tasks' decisions** (B01-6a): each one mutation — the rule first, then the domain write
 * through its existing impl, then the settle with that write's audit row — so a decision can't
 * half-land.
 *
 * PLACEHOLDER (S2's): the T0 stub. The arguments are the briefs' canonical snippet (*The writes*),
 * validated, so the web compiles against `api.corpusWrites.*` now; each throws until S2 replaces
 * this file. No `decideContested` in 6a: it lands with the Contested lane in 6b (D306).
 */

import { WATER_BODY_CLASSES } from '@skating/core';
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireCapability } from './lib/auth';
import type { CorpusDecisionResult } from './lib/decisionResult';
import { literals } from './lib/validators';

/**
 * `pickName`: `pick` one of the body's catalog name claims → `setWaterBodyNameImpl`, decision
 * `renamed` (`body.identity`). `keepName`: `pick: 'shown'` → no domain write,
 * `settle_review_reason`, `kept` (`corpus.intake`). PLACEHOLDER (S2's).
 */
export const decideName = mutation({
  args: { taskId: v.id('corpusTasks'), pick: v.string() },
  handler: async (ctx): Promise<CorpusDecisionResult> => {
    // PLACEHOLDER (S2's): the stub's floor, so the capability map's guard sees `corpus.intake` in a
    // gate; S2 replaces it with `corpusCan`, whose per-verb capability decides.
    await requireCapability(ctx, 'corpus.intake');
    throw new Error('PLACEHOLDER (S2): corpusWrites.decideName is not built yet');
  },
});

/**
 * `setClass`: a class not the body's → `setClassImpl`, `reclassed` (`body.identity`). `keepClass`:
 * the body's own class → `settle_review_reason`, `kept` (`corpus.intake`). PLACEHOLDER (S2's).
 */
export const decideClass = mutation({
  args: { taskId: v.id('corpusTasks'), bodyClass: literals(WATER_BODY_CLASSES) },
  handler: async (ctx): Promise<CorpusDecisionResult> => {
    // PLACEHOLDER (S2's): the stub's floor, so the capability map's guard sees `corpus.intake` in a
    // gate; S2 replaces it with `corpusCan`, whose per-verb capability decides.
    await requireCapability(ctx, 'corpus.intake');
    throw new Error('PLACEHOLDER (S2): corpusWrites.decideClass is not built yet');
  },
});
