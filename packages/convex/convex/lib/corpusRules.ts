/**
 * **Per-row `can` for the Corpus tasks: one rule shared by read and write** (B01-6a), in
 * `lib/inboxRules.ts`' shape.
 *
 * PLACEHOLDER (S2's): the T0 stub. Its signatures are the briefs' canonical snippet (*The rule*);
 * every body throws until S2 replaces this file. S3's `can` and every write ask it.
 */

import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/** 6a's verbs; 6b's Contested lane adds `remove` and `setDormant` (D306). */
export type CorpusVerb = 'pickName' | 'keepName' | 'setClass' | 'keepClass';

/** `null`: allowed. A sentence: the write's own refusal. A verb absent: not this lane's. */
export type CorpusCan = Partial<Record<CorpusVerb, string | null>>;

/**
 * In one order: capability (D217) → decided (D283's lock) → the body merged away or removed → the
 * verb's preconditions. PLACEHOLDER (S2's).
 */
export async function corpusCan(
  _ctx: QueryCtx,
  _viewer: Doc<'profiles'>,
  _task: Doc<'corpusTasks'>,
  _body: Doc<'waterBodies'> | null,
): Promise<CorpusCan> {
  throw new Error('PLACEHOLDER (S2): lib/corpusRules.corpusCan is not built yet');
}

/** One verb's refusal, as `corpusCan` would say it, or `null`. PLACEHOLDER (S2's). */
export async function corpusVerbRefusal(
  _ctx: QueryCtx,
  _viewer: Doc<'profiles'>,
  _task: Doc<'corpusTasks'>,
  _body: Doc<'waterBodies'> | null,
  _verb: CorpusVerb,
): Promise<string | null> {
  throw new Error('PLACEHOLDER (S2): lib/corpusRules.corpusVerbRefusal is not built yet');
}
