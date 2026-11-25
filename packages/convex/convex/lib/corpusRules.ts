/**
 * **Per-row `can` for the Corpus tasks: one rule shared by read and write** (B01-7a), in
 * `lib/inboxRules.ts`' shape. For a viewer and a task, each verb its lane draws answers `null`
 * (allowed) or the sentence its write refuses with — and every Corpus write asks the same function
 * before it writes ({@link assertCorpusVerb}), so a lever is never drawn that its write refuses
 * (D217), and a refusal that comes anyway is the server's sentence for a toast (D268).
 *
 * In order, the first that refuses answers:
 *
 * 1. **The capability** (D217) — the verb's ({@link CORPUS_VERB_CAPABILITY}), in `requireCapability`'s
 *    words: a decision that changes the body needs that change's own capability; one that changes
 *    nothing but the queue needs `corpus.intake`.
 * 2. **The lock** (D283) — a task someone decided (*Decided by Sarah · renamed*), or one that left
 *    with no decision (its question went away): the writer's own `taskLockRefusal`, the sentence
 *    `taskToDecide` throws, so the read and the write can't word it apart.
 * 3. **The subject changed under it** — an open task whose body is gone, merged away or removed, in
 *    the writer's words for a task that left for that reason (`TASK_LEFT`).
 * 4. **The verb's own precondition** — from the body's stored facts: *Pick* needs a catalog name to
 *    pick that isn't the one shown.
 *
 * A verb absent from {@link CorpusCan} is not the task's lane's (never drawn); asked of the write, it
 * is refused first, before the capability, since no capability makes it this lane's. What a write's
 * argument names (which name, which class) is checked by the write after the rule
 * ({@link namePickRefusal}): the read has no argument to check.
 */

import type { Capability, CorpusTaskLane } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { goneBecause, TASK_LEFT, taskLockRefusal } from './corpusTasks';
import { capabilityRefusal } from './inboxRules';

/** 7a's verbs; 7b's Contested lane adds `remove` and `setDormant` (D307). */
export type CorpusVerb = 'pickName' | 'keepName' | 'setClass' | 'keepClass';

/** `null`: allowed. A sentence: the write's own refusal. A verb absent: not this lane's. */
export type CorpusCan = Partial<Record<CorpusVerb, string | null>>;

/** Each lane's verbs, in the order its handler draws them. */
export const CORPUS_LANE_VERBS = {
  nameConflicts: ['pickName', 'keepName'],
  classConflicts: ['setClass', 'keepClass'],
} as const satisfies Record<CorpusTaskLane, readonly CorpusVerb[]>;

/**
 * What each verb needs (D217): a change to the body takes that change's own capability — the one
 * `setWaterBodyName` and `setClass` gate on — and a *Keep*, which changes nothing but the queue,
 * takes `corpus.intake`. `corpusWrites.ts` gates on the same capability for each verb.
 */
export const CORPUS_VERB_CAPABILITY = {
  pickName: 'body.identity',
  keepName: 'corpus.intake',
  setClass: 'body.identity',
  keepClass: 'corpus.intake',
} as const satisfies Record<CorpusVerb, Capability>;

/** The lane each verb belongs to. */
const VERB_LANE: Record<CorpusVerb, CorpusTaskLane> = {
  pickName: 'nameConflicts',
  keepName: 'nameConflicts',
  setClass: 'classConflicts',
  keepClass: 'classConflicts',
};

/** A write asked of a task in another lane (a client's mistake; never drawn). */
export const NOT_THIS_LANE: Record<CorpusTaskLane, string> = {
  nameConflicts: 'This task isn’t a name conflict.',
  classConflicts: 'This task isn’t a class conflict.',
};
/** *Pick* on a body no catalog gives another name. */
export const NO_OTHER_NAME = 'No catalog gives this body another name to show.';
/** A pick that isn't one of the catalogs' names for the body. */
export const NOT_A_CATALOG_NAME = 'That name isn’t one the catalogs give this body.';
/** A pick of the name already shown: that is *Keep*. */
export const ALREADY_SHOWN = 'That name is the one shown now; keep it instead.';

/** The case- and space-insensitive key two spellings are the same name by (`nameClaims`' rule). */
const nameKey = (value: string) => value.trim().toLowerCase();

/** The catalogs' names for the body (never a moderator's own claim). */
const catalogNames = (body: Doc<'waterBodies'>) =>
  (body.nameClaims ?? []).filter((c) => c.source !== 'user');

/** Rule 4: the verb's own precondition, from the body's stored facts. */
function preconditionRefusal(verb: CorpusVerb, body: Doc<'waterBodies'>): string | null {
  if (verb !== 'pickName') return null;
  const shown = nameKey(body.name);
  return catalogNames(body).some((c) => nameKey(c.value) !== shown) ? null : NO_OTHER_NAME;
}

/**
 * Rules 2–4, which are the same for every verb of a lane: the lock, the body gone, merged or
 * removed, then the precondition per verb. The lock reads the decider's profile (one row) when the
 * task is decided; nothing else is read.
 */
async function taskRefusals(
  ctx: QueryCtx,
  task: Doc<'corpusTasks'>,
  body: Doc<'waterBodies'> | null,
): Promise<(verb: CorpusVerb) => string | null> {
  const locked = await taskLockRefusal(ctx, task);
  if (locked !== null) return () => locked;
  const gone = goneBecause(body);
  if (gone !== null || body === null) return () => TASK_LEFT[gone ?? 'deleted'];
  return (verb) => preconditionRefusal(verb, body);
}

/** Rule 1, then the task's own rungs, for one verb of the task's lane. */
function laneVerbRefusal(
  viewer: Doc<'profiles'>,
  rest: (verb: CorpusVerb) => string | null,
  verb: CorpusVerb,
): string | null {
  return capabilityRefusal(viewer, CORPUS_VERB_CAPABILITY[verb]) ?? rest(verb);
}

/**
 * The task's `can`: every verb its lane draws, each `null` or the write's refusal — in one order:
 * capability (D217) → the lock (D283: decided, or left) → the body merged away or removed → the
 * verb's preconditions. `body` is the task's, read by the caller (`null`: gone). It reads the
 * decider's profile for a decided task's lock, and nothing else.
 */
export async function corpusCan(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  task: Doc<'corpusTasks'>,
  body: Doc<'waterBodies'> | null,
): Promise<CorpusCan> {
  const rest = await taskRefusals(ctx, task, body);
  const can: CorpusCan = {};
  for (const verb of CORPUS_LANE_VERBS[task.lane]) can[verb] = laneVerbRefusal(viewer, rest, verb);
  return can;
}

/**
 * The rule's answer for one verb, drawn or not: `null` (allowed) or the write's sentence — a verb of
 * another lane first ({@link NOT_THIS_LANE}), then {@link corpusCan}'s answer for it.
 */
export async function corpusVerbRefusal(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  task: Doc<'corpusTasks'>,
  body: Doc<'waterBodies'> | null,
  verb: CorpusVerb,
): Promise<string | null> {
  if (VERB_LANE[verb] !== task.lane) return NOT_THIS_LANE[VERB_LANE[verb]];
  return laneVerbRefusal(viewer, await taskRefusals(ctx, task, body), verb);
}

/** The write's side: refuse `verb` on `task` in the rule's words (a `ConvexError`, for a toast). */
export async function assertCorpusVerb(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  task: Doc<'corpusTasks'>,
  body: Doc<'waterBodies'> | null,
  verb: CorpusVerb,
): Promise<void> {
  const refused = await corpusVerbRefusal(ctx, viewer, task, body, verb);
  if (refused !== null) throw new ConvexError(refused);
}

/**
 * What *Pick* is told of the name it names, after the rule allowed the verb: the catalog claim it
 * picks, or the refusal — a name already shown (that is *Keep*), or one no catalog gives this body
 * (the refused name stays a claim and searchable; free text never becomes a name here).
 */
export function namePickRefusal(
  body: Doc<'waterBodies'>,
  pick: string,
): { claim: { source: string; value: string } } | { refused: string } {
  const key = nameKey(pick);
  if (key === nameKey(body.name)) return { refused: ALREADY_SHOWN };
  const claim = catalogNames(body).find((c) => nameKey(c.value) === key);
  return claim ? { claim } : { refused: NOT_A_CATALOG_NAME };
}
