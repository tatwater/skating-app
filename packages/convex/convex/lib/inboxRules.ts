/**
 * **One rule per Inbox verb, shared by the read and the write** (B01-5, *Per-row `can`*; as
 * `lib/recordRules` is for the record sheet). For a viewer and an item, each verb its handler draws
 * answers `null` (allowed) or the sentence the write refuses with — and every Inbox write asks the
 * same function before it writes ({@link assertInboxVerb}), so a lever is never drawn that its write
 * refuses (D217), and a refusal that comes anyway is the server's sentence for a toast (D268).
 *
 * In order, the first that refuses answers:
 *
 * 1. **The capability** (D217) — the verb's, as `requireCapability` words it; a write is refused to a
 *    staffer on their way out, as `requireContributor` words it.
 * 2. **A decided item** (D283) — every verb but a ticket's *Reopen*.
 * 3. **Their own filing** (D289) — any member the viewer filed: another staffer decides it.
 * 4. **Their own content** (D269) — a flag about them or their content (`lib/ownContent`).
 * 5. **The verb's own preconditions** — from the facts the item's read (and the write) hold: an admit
 *    with no catalog match, a bay not yet drawn, content already down, an alert its author took down.
 *
 * A row's `can` (the list) asks 1–4, which need no reads beyond the item and one filer probe; the
 * item's (`inbox.item`) adds 5 from the facts it reads anyway. A seed-origin ask is never an item, so
 * nothing here applies to it (D289, amended: any staffer holding the capability decides it).
 */

import { CAPABILITIES, type Capability, type InboxItemKind, type RequestKind } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { InboxCan, InboxVerb } from '../inbox';
import { DELETION_PENDING_MESSAGE, hasCapability } from './auth';
import { ownContentRefusal } from './ownContent';
import { ERASED_ALREADY, type RecordFacts, recordRefusal, takedownRefusal } from './recordRules';

/** What `setContentStatus` says of content whose row is gone (before it reads the record). */
export const CONTENT_GONE = 'Target not found';

/** What `corpusRequests.approve` says of an admit the catalog hasn't matched (its own words). */
export function unmatchedAdmitRefusal(resolveError: string | null | undefined): string {
  return resolveError
    ? `The catalog lookup did not find water here (${resolveError}). Re-resolve, or decline.`
    : 'The catalog lookup has not answered yet.';
}

/** What `corpusRequests.approve` says of a catalog feature that is flowing water or a canal. */
export const FLOWING_ADMIT_REFUSAL =
  'The catalog classifies this as flowing water or a canal, which the corpus does not hold. Decline it, or draw it by hand in the lake editor.';

/** D283: an item someone decided takes no further decision. */
export const DECIDED_REFUSAL = 'This has already been decided.';
/** D289: no staffer decides an ask or a flag they filed. */
export const OWN_FILING_REFUSAL = 'You filed this, so another staff member decides it.';

/** The capabilities each verb needs (all of them). */
export function capabilitiesFor(
  verb: InboxVerb,
  facts: Pick<InboxRuleFacts, 'requestKind'> = {},
): Capability[] {
  switch (verb) {
    case 'dismiss':
      return ['inbox.flag'];
    case 'hide':
    case 'remove':
    case 'restore':
      return ['inbox.flag', 'content.moderate'];
    case 'unpin':
    case 'retract':
      return ['access.alert'];
    case 'ruleClosed':
    case 'ruleAccessible':
    case 'clearRuling':
      return ['access.rule'];
    case 'approve':
      // Restoring or taking down a body is the body.remove lever itself (D48).
      return facts.requestKind === 'restore' || facts.requestKind === 'takedown'
        ? ['body.remove']
        : ['inbox.request'];
    case 'decline':
    case 'sameAs':
    case 'lookUpAgain':
      return ['inbox.request'];
    case 'approveDrawn':
    case 'rejectDrawn':
      return ['inbox.drawnBody'];
    case 'mergeDrawn':
      return ['inbox.drawnBody', 'corpus.duplicates'];
    case 'reply':
    case 'note':
    case 'resolve':
    case 'reopen':
      return ['inbox.support'];
  }
}

/** What a viewer without `capability` is told — `requireCapability`'s own words. */
function capabilityRefusal(viewer: Doc<'profiles'>, capability: Capability): string | null {
  if (!hasCapability(viewer, capability)) return `Requires ${CAPABILITIES[capability].role} role`;
  if (CAPABILITIES[capability].write && viewer.deletionRequestedAt !== undefined) {
    return DELETION_PENDING_MESSAGE;
  }
  return null;
}

/** The facts the preconditions read, as the item's read (or the write) holds them. */
export type InboxRuleFacts = {
  /** A flag's target type, and its content's moderation status (`null`: gone or no such axis). */
  targetType?: Doc<'contentFlags'>['targetType'];
  targetStatus?: 'visible' | 'hidden' | 'removed' | null;
  /** An alert target's status and whether staff pinned it. */
  alert?: { status: Doc<'accessAlerts'>['status']; pinned: boolean } | null;
  /** The access ruling standing on the body. */
  hasRuling?: boolean;
  requestKind?: RequestKind;
  /** An admit's catalog match. */
  hasCandidate?: boolean;
  /** An admit's lookup failure, as the resolver recorded it (the write words its refusal by it). */
  resolveError?: string | null;
  /** An admit's catalog feature is flowing water or a canal, which the corpus doesn't hold. */
  candidateFlowing?: boolean;
  /** A bay ask: the bay by that name drawn on the body, else the write's sentence for why not. */
  bayMissing?: string | null;
  /** A landmark ask: the landmark that answers it, else the write's sentence for why not. */
  landmarkMissing?: string | null;
  hasLookalike?: boolean;
  hasOverlap?: boolean;
  /**
   * A flagged content row's record facts (`lib/recordRules`), read as `setContentStatus` reads them:
   * the decision standing on it, whether its author withdrew it or it was erased, a Post's members.
   * The item's read supplies them, and Hide, Remove and Restore answer from them; a write that
   * doesn't supply them leaves those verbs to `setContentStatus`, which refuses by the same function.
   */
  record?: RecordFacts;
};

/**
 * **Hide, Remove and Restore on flagged content: one rule with the write.** `setContentStatus`'
 * own order over the same facts — erased is gone (D248); then a restore by `recordRefusal` (an
 * author's deletion never comes back, D248; content already up has nothing to restore; a Post that
 * would show none of its Reports needs the record sheet's choice) and a takedown by
 * `takedownRefusal` (what a decision of that kind already holds changes nothing, D270).
 */
export function contentVerbRefusal(
  record: RecordFacts,
  verb: 'hide' | 'remove' | 'restore',
): string | null {
  // A row gone altogether is refused before the record is read, in the write's own word.
  if (record.gone) return CONTENT_GONE;
  if (record.erased) return ERASED_ALREADY;
  return verb === 'restore'
    ? recordRefusal(record, 'restore')
    : takedownRefusal(record, verb === 'hide' ? 'hidden' : 'removed');
}

/** The verbs an item's handler draws, from its kind and facts. */
export function verbsOf(
  item: Pick<Doc<'inboxItems'>, 'kind' | 'status'>,
  facts: InboxRuleFacts,
): InboxVerb[] {
  switch (item.kind as InboxItemKind) {
    case 'flag': {
      if (facts.targetType === 'user' || facts.targetType === 'waterbody') return ['dismiss'];
      if (facts.targetType === 'accessAlert') return ['dismiss', 'unpin', 'retract'];
      const down = facts.targetStatus === 'hidden' || facts.targetStatus === 'removed';
      return down ? ['dismiss', 'restore'] : ['dismiss', 'hide', 'remove'];
    }
    case 'access':
      return facts.hasRuling
        ? ['ruleClosed', 'ruleAccessible', 'clearRuling']
        : ['ruleClosed', 'ruleAccessible'];
    case 'request':
      return facts.requestKind === 'admit' && !facts.hasCandidate
        ? ['lookUpAgain', 'decline']
        : ['approve', 'decline'];
    case 'place':
      return facts.hasLookalike ? ['approve', 'sameAs', 'decline'] : ['approve', 'decline'];
    case 'drawn':
      return facts.hasOverlap
        ? ['approveDrawn', 'mergeDrawn', 'rejectDrawn']
        : ['approveDrawn', 'rejectDrawn'];
    case 'ticket':
      return item.status === 'decided' ? ['reopen'] : ['reply', 'note', 'resolve'];
  }
}

/** Whether `viewer` filed any member of the item (D289). */
export async function filedByViewer(
  ctx: QueryCtx,
  itemId: Id<'inboxItems'>,
  viewerId: Id<'profiles'>,
): Promise<boolean> {
  const hit = await ctx.db
    .query('inboxItemMembers')
    .withIndex('by_item_filer', (q) => q.eq('itemId', itemId).eq('filedByUserId', viewerId))
    .first();
  return hit !== null;
}

type RuleItem = Pick<Doc<'inboxItems'>, '_id' | 'kind' | 'status' | 'subjectUserId' | 'key'>;

/** The verbs that close every open flag on a flag item's target, in every lane (`inboxWrites`). */
const CLOSES_EVERY_LANE: ReadonlySet<InboxVerb> = new Set(['hide', 'remove', 'unpin', 'retract']);

/** Content a takedown or a restore moves (a photo's axis is the precondition's to refuse). */
const CONTENT_TARGETS: ReadonlySet<string> = new Set([
  'report',
  'post',
  'comment',
  'hazard',
  'photo',
]);

/** The verbs each kind of item has at all, whatever its state. */
const KIND_VERBS: Record<InboxItemKind, ReadonlySet<InboxVerb>> = {
  flag: new Set(['dismiss', 'hide', 'remove', 'restore', 'unpin', 'retract']),
  // `dismiss` too: the old flags page's one-flag resolution (`moderation.resolveFlag`) asks it of any
  // flag's item, an access report's included; the Access handler itself draws only the rulings.
  access: new Set(['ruleClosed', 'ruleAccessible', 'clearRuling', 'dismiss']),
  request: new Set(['approve', 'decline', 'sameAs', 'lookUpAgain']),
  place: new Set(['approve', 'decline', 'sameAs', 'lookUpAgain']),
  drawn: new Set(['approveDrawn', 'rejectDrawn', 'mergeDrawn']),
  ticket: new Set(['reply', 'note', 'resolve', 'reopen']),
};

/** What a verb outside an item's choices is told (a write that would act on the wrong kind of thing). */
export const NOT_A_CHOICE_REFUSAL = 'That isn’t a choice for this item.';

/**
 * Whether `verb` is a choice for this item at all — its kind's verbs, and for a flag item the target's:
 * a takedown or a restore moves content, an unpin or a retraction an alert. `null` when it is (or the
 * target's kind isn't known, as on a list row).
 */
export function choiceRefusal(
  item: Pick<Doc<'inboxItems'>, 'kind'>,
  verb: InboxVerb,
  facts: Pick<InboxRuleFacts, 'targetType'>,
): string | null {
  if (!KIND_VERBS[item.kind as InboxItemKind].has(verb)) return NOT_A_CHOICE_REFUSAL;
  if (item.kind !== 'flag' || facts.targetType === undefined) return null;
  if (
    (verb === 'hide' || verb === 'remove' || verb === 'restore') &&
    !CONTENT_TARGETS.has(facts.targetType)
  ) {
    return NOT_A_CHOICE_REFUSAL;
  }
  if ((verb === 'unpin' || verb === 'retract') && facts.targetType !== 'accessAlert') {
    return NOT_A_CHOICE_REFUSAL;
  }
  return null;
}

/**
 * Whether `viewer` has an open flag of their own on a flag item's target, in any lane (D289): a
 * takedown, an unpin or a retraction closes every open flag on the target, so one the viewer filed in
 * another lane would be theirs to decide. Read from the item's key (`flag:<lane>:<type>:<id>`).
 */
export async function filedOnTarget(
  ctx: QueryCtx,
  item: Pick<Doc<'inboxItems'>, 'kind' | 'key'>,
  viewerId: Id<'profiles'>,
): Promise<boolean> {
  if (item.kind !== 'flag') return false;
  const [, , targetType, ...rest] = item.key.split(':');
  const targetId = rest.join(':');
  if (!targetType || !targetId) return false;
  for (const status of ['open', 'reviewing'] as const) {
    const open = await ctx.db
      .query('contentFlags')
      .withIndex('by_target_status_reason', (q) =>
        q
          .eq('targetType', targetType as Doc<'contentFlags'>['targetType'])
          .eq('targetId', targetId)
          .eq('status', status),
      )
      .take(MAX_TARGET_FLAGS);
    if (open.some((f) => f.origin === 'user' && f.flaggerId === viewerId)) return true;
  }
  return false;
}

/** The open flags on one target read for {@link filedOnTarget} (one per flagger, so a handful). */
const MAX_TARGET_FLAGS = 500;

/** Rules 1–4: who may act on this item at all, for `verb`. */
export function whoRefusal(
  viewer: Doc<'profiles'>,
  item: RuleItem,
  verb: InboxVerb,
  filed: boolean,
  facts: Pick<InboxRuleFacts, 'requestKind'> = {},
): string | null {
  for (const cap of capabilitiesFor(verb, facts)) {
    const refused = capabilityRefusal(viewer, cap);
    if (refused !== null) return refused;
  }
  const decidedOk = item.kind === 'ticket' && verb === 'reopen';
  if (item.status === 'decided' && !decidedOk) return DECIDED_REFUSAL;
  if (item.status === 'open' && verb === 'reopen') return 'This ticket is still open.';
  if (filed) return OWN_FILING_REFUSAL;
  if (item.kind === 'flag' || item.kind === 'access') {
    const own = ownContentRefusal(viewer, item.subjectUserId);
    if (own !== null) return own;
  }
  return null;
}

/** Rule 5: the verb's own precondition, from the item's facts. */
export function preconditionRefusal(verb: InboxVerb, facts: InboxRuleFacts): string | null {
  switch (verb) {
    case 'hide':
    case 'remove':
    case 'restore':
      if (facts.targetType === 'photo') return 'A photo can’t be hidden or removed yet.';
      return facts.record ? contentVerbRefusal(facts.record, verb) : null;
    case 'unpin':
      if (!facts.alert) return 'This alert is gone.';
      return facts.alert.pinned ? null : 'This alert isn’t pinned.';
    case 'retract':
      if (!facts.alert) return 'This alert is gone.';
      return facts.alert.status === 'retracted' ? 'Its author already took this alert down.' : null;
    case 'clearRuling':
      return facts.hasRuling ? null : 'There is no ruling to clear.';
    case 'approve':
      if (facts.requestKind === 'admit' && !facts.hasCandidate) {
        return unmatchedAdmitRefusal(facts.resolveError);
      }
      if (facts.requestKind === 'admit' && facts.candidateFlowing) return FLOWING_ADMIT_REFUSAL;
      if (facts.requestKind === 'name_bay' && facts.bayMissing) return facts.bayMissing;
      if (facts.requestKind === 'name_landmark' && facts.landmarkMissing)
        return facts.landmarkMissing;
      return null;
    case 'sameAs':
      return facts.requestKind === 'name_landmark' && facts.hasLookalike
        ? null
        : 'Nothing here looks like the same place.';
    case 'lookUpAgain':
      return facts.requestKind === 'admit' ? null : 'Only an admit is looked up in the catalog.';
    case 'mergeDrawn':
      return facts.hasOverlap ? null : 'This drawing overlaps no known body.';
    default:
      return null;
  }
}

/**
 * The item's `can`: every verb its handler draws, each `null` or the write's refusal. `facts` absent
 * (a list row) answers rules 1–4 only, for the verbs the kind always draws.
 */
export async function inboxCan(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  item: RuleItem,
  facts?: InboxRuleFacts,
): Promise<InboxCan> {
  const filed = await filedByViewer(ctx, item._id, viewer._id);
  const verbs = verbsOf(item, facts ?? {});
  const onTarget =
    !filed && verbs.some((v) => CLOSES_EVERY_LANE.has(v))
      ? await filedOnTarget(ctx, item, viewer._id)
      : false;
  const can: InboxCan = {};
  for (const verb of verbs) {
    can[verb] =
      whoRefusal(viewer, item, verb, filed || (onTarget && CLOSES_EVERY_LANE.has(verb)), facts) ??
      (facts ? preconditionRefusal(verb, facts) : null);
  }
  return can;
}

/** The rule's answer for one verb, drawn or not: `null` (allowed) or the write's sentence. */
export async function inboxVerbRefusal(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  item: RuleItem,
  verb: InboxVerb,
  facts: InboxRuleFacts = {},
): Promise<string | null> {
  const choice = choiceRefusal(item, verb, facts);
  if (choice !== null) return choice;
  const filed =
    (await filedByViewer(ctx, item._id, viewer._id)) ||
    (CLOSES_EVERY_LANE.has(verb) && (await filedOnTarget(ctx, item, viewer._id)));
  return whoRefusal(viewer, item, verb, filed, facts) ?? preconditionRefusal(verb, facts);
}

/** The write's side: refuse `verb` on `item` in the rule's words (a `ConvexError`, for a toast). */
export async function assertInboxVerb(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  item: RuleItem,
  verb: InboxVerb,
  facts: InboxRuleFacts = {},
): Promise<void> {
  const refused = await inboxVerbRefusal(ctx, viewer, item, verb, facts);
  if (refused !== null) throw new ConvexError(refused);
}
