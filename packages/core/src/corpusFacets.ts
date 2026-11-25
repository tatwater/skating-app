/**
 * **The facet a Corpus task is filed in**, from the body's stored facts (B01-6a).
 *
 * PLACEHOLDER (S1's): the T0 stub. Its signature is the briefs' canonical snippet; S1 replaces the
 * body (and this paragraph) with the rule and its tests.
 */

import type { CorpusTaskFacet, CorpusTaskLane } from './corpusTasks';
import type { EvidenceRecord } from './reviewEvidence';
import type { WaterBodyClass } from './types';

/** The record `facetOf` reads: the evidence, the shown name and the body's class. */
export type FacetRecord = EvidenceRecord & { name: string; type: WaterBodyClass };

/** One of `CORPUS_TASK_FACETS[lane]`, never *All*. */
export function facetOf(_lane: CorpusTaskLane, _record: FacetRecord): CorpusTaskFacet {
  throw new Error('PLACEHOLDER (S1): facetOf is not built yet');
}
