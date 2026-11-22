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

import {
  CAPABILITIES,
  type Capability,
  coveredFraction,
  type InboxItemKind,
  MERGE_SUGGEST_SHARE,
  mergedModeratorLists,
  type RequestKind,
} from '@skating/core';
import { ConvexError } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { InboxCan, InboxCanCode, InboxVerb } from '../inbox';
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
/** A pin of an alert already pinned (`accessAlerts.ALERT_ALREADY_PINNED`'s words). */
export const ALERT_PINNED_ALREADY = 'This alert is already pinned.';
/** A pin of a retracted alert: a withdrawn claim is never put back up (D248). */
export const ALERT_RETRACTED_NO_PIN = 'This alert has been retracted, so it can’t be pinned.';
/** D289: no staffer decides an ask or a flag they filed. */
export const OWN_FILING_REFUSAL = 'You filed this, so another staff member decides it.';
/**
 * A decision whose reach over the viewer's own asks couldn't be checked inside the read's budget
 * (D289, PR #170): never decided unseen.
 */
export const ALONGSIDE_UNCHECKED =
  'Your own open asks couldn’t all be checked against this just now, so another staff member decides it.';

/** Whether a decision would close one of the viewer's own asks: yes, no, or it couldn't be checked. */
export type AlongsideAnswer = 'own' | 'clear' | 'unchecked';

// ── A drawing's live survivor (B01-5d) ────────────────────────────────────────────────────────

/** The most of a drawing's dedup candidates the survivor search reads — create stores a handful. */
export const DRAWN_SURVIVOR_READ = 8;

/** What a drawing merges into: its live survivor, and the share of the drawing inside it (0–1). */
export type DrawnSurvivor = {
  survivor: Doc<'waterBodies'>;
  share: number;
  /** The share is at or past the merge threshold (*Merge suggested from 80 %*). */
  suggested: boolean;
};

/**
 * **D289 on a drawing's merge — one sentence and one code** (B01-5d): the staffer who drew a drawing
 * in review doesn't merge it. The Inbox's `can.mergeDrawn` (and its `canCode`) and the Shape tab's
 * preview and `waterBodies.merge` (`mergePairRefusal`) all answer with this.
 */
export const OWN_DRAWING = { refusal: OWN_FILING_REFUSAL, code: 'ownDrawing' } as const;

/** {@link OWN_DRAWING} when `viewerId` drew this drawing still in review, else `null`. */
export function ownDrawingRefusal(
  drawing: Pick<Doc<'waterBodies'>, 'source' | 'reviewStatus' | 'createdByUserId'>,
  viewerId: Id<'profiles'>,
): typeof OWN_DRAWING | null {
  return drawing.source === 'user' &&
    drawing.reviewStatus === 'pending' &&
    drawing.createdByUserId === viewerId
    ? OWN_DRAWING
    : null;
}

/** What a drawing that overlaps no live body is told — the rule's sentence for `mergeDrawn`. */
export const NO_OVERLAP_REFUSAL = 'This drawing overlaps no known body.';
/** A `mergeDrawn` whose survivor the bar showed is no longer the drawing's live survivor. */
export const SURVIVOR_CHANGED_REFUSAL =
  'The body this drawing overlaps has changed since this page loaded. Look again before merging.';

/**
 * **The drawing's live survivor — the one function** (B01-5d) the Inbox rule's `hasOverlap`, the
 * Drawn item's `overlap` and `body` and `mergeDrawn`'s currency check all read, so `can` and the bar
 * never disagree: the first of the drawing's dedup candidates (in create's ranking, the best match
 * first) that is **neither merged nor gone** — a tombstoned first candidate is passed over for the
 * next, never offered and then refused — with the share of the drawing inside it, from core's
 * `coveredFraction`. `null` when no candidate among the first {@link DRAWN_SURVIVOR_READ} is live, or
 * the outlines can't be measured (missing, or the clipper fails): then there is no merge to offer.
 * `get` is how the caller reads a body — charged to an item's budget in a view, plain in a write.
 */
export async function drawnSurvivorOf(
  drawn: Pick<Doc<'waterBodies'>, '_id' | 'polygon' | 'duplicateCandidateIds'>,
  get: (id: Id<'waterBodies'>) => Promise<Doc<'waterBodies'> | null>,
): Promise<DrawnSurvivor | null> {
  const body = await liveSurvivorOf(drawn, get);
  if (!body || !drawn.polygon || !body.polygon) return null;
  try {
    const share = coveredFraction(
      drawn.polygon as unknown as Polygon | MultiPolygon,
      body.polygon as unknown as Polygon | MultiPolygon,
    );
    return { survivor: body, share, suggested: share >= MERGE_SUGGEST_SHARE };
  } catch {
    return null;
  }
}

/** The facts `mergeDrawn`'s rule reads, from the drawing's live survivor — the view's and the write's. */
export function drawnMergeFacts(
  drawn: Doc<'waterBodies'>,
  live: DrawnSurvivor | null,
): Pick<InboxRuleFacts, 'hasOverlap' | 'mergeListsRefusal'> {
  return {
    hasOverlap: live !== null,
    mergeListsRefusal: live ? mergedModeratorLists(live.survivor, [drawn]).refusal : null,
  };
}

/**
 * The survivor half of {@link drawnSurvivorOf}, without the share — what a list row names (*over
 * ‹body›*), with no outline arithmetic per row. The first candidate neither merged nor gone.
 */
export async function liveSurvivorOf(
  drawn: Pick<Doc<'waterBodies'>, '_id' | 'duplicateCandidateIds'>,
  get: (id: Id<'waterBodies'>) => Promise<Doc<'waterBodies'> | null>,
): Promise<Doc<'waterBodies'> | null> {
  for (const id of (drawn.duplicateCandidateIds ?? []).slice(0, DRAWN_SURVIVOR_READ)) {
    if (id === drawn._id) continue;
    const body = await get(id);
    if (!body || body.dedupStatus === 'merged' || body.mergedIntoId !== undefined) continue;
    return body;
  }
  return null;
}

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
    case 'pin':
    case 'unpin':
    case 'retract':
      return ['access.alert'];
    case 'ruleClosed':
    case 'ruleAccessible':
    case 'clearRuling':
      return ['access.rule'];
    case 'approve':
    case 'decline':
      // Restoring or taking down a body is the body.remove lever itself (D48) — and an admin decides
      // these both ways: declining one is as much the decision as approving it (B01-5c, ruled).
      return facts.requestKind === 'restore' || facts.requestKind === 'takedown'
        ? ['body.remove']
        : ['inbox.request'];
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
export function capabilityRefusal(
  viewer: Pick<Doc<'profiles'>, 'role' | 'canEditLedger' | 'deletionRequestedAt'>,
  capability: Capability,
): string | null {
  if (!hasCapability(viewer, capability)) return `Requires ${CAPABILITIES[capability].role} role`;
  if (CAPABILITIES[capability].write && viewer.deletionRequestedAt !== undefined) {
    return DELETION_PENDING_MESSAGE;
  }
  return null;
}

/** *Same place* asked of an ask no landmark looks like (`approve` with `sameAs` answers it too). */
export const SAME_AS_REFUSAL = 'Nothing here looks like the same place.';

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
   * A drawing's merge into its live survivor refused by the lists' union (B01-3g's
   * `mergedModeratorLists`, the merge's own check), else `null` (B01-5d).
   */
  mergeListsRefusal?: string | null;
  /**
   * An ask's decision, per verb: the viewer has an open ask of their own among those it would close in
   * another item — a sibling its drain reaches through an answer's names or a landmark's place
   * (`lib/requestDecisions.askedAlongside`, D289). Approving (and *Same as*) and declining reach
   * different sets, so each is its own answer.
   */
  askedAlongside?: { approve?: AlongsideAnswer; decline?: AlongsideAnswer };
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
      if (facts.targetType === 'accessAlert') return ['dismiss', 'pin', 'unpin', 'retract'];
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
const CLOSES_EVERY_LANE: ReadonlySet<InboxVerb> = new Set([
  'hide',
  'remove',
  'pin',
  'unpin',
  'retract',
]);

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
  flag: new Set(['dismiss', 'hide', 'remove', 'restore', 'pin', 'unpin', 'retract']),
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
  if (
    (verb === 'pin' || verb === 'unpin' || verb === 'retract') &&
    facts.targetType !== 'accessAlert'
  ) {
    return NOT_A_CHOICE_REFUSAL;
  }
  return null;
}

/** How a read is made: plainly (a write), or charged to a page's budget (a list row, `InboxReader`). */
export type RuleTake = <T>(n: number, read: (n: number) => Promise<T[]>) => Promise<T[]>;
const plainTake: RuleTake = (n, read) => read(n);

/** The flag lanes a target's open flags can sit in, as items keyed `flag:<lane>:<type>:<id>`. */
const FLAG_LANES = ['safety', 'contentFlags'] as const;

/**
 * Whether `viewer` has an open flag of their own on a flag item's target, in another lane (D289): a
 * takedown, an unpin or a retraction closes every open flag on the target, so one the viewer filed in
 * another lane would be theirs to decide. Point reads only — each other lane's open item on the same
 * target, by its key (`flag:<lane>:<type>:<id>`), then whether the viewer has an open member of it
 * (`by_item_filer`, `eq` on the item, the viewer and `open`: never the first few of their members,
 * which closed ones of theirs can fill — PR #170); this item's own members are `filedByViewer`'s — so
 * a list row reads at most two small rows, charged to the page's budget through `take`. Every open
 * source row is the open member of the one open item its fields key (the writer's invariant), so
 * these reads are the whole answer.
 */
export async function filedOnTarget(
  ctx: QueryCtx,
  item: Pick<Doc<'inboxItems'>, 'kind' | 'key'>,
  viewerId: Id<'profiles'>,
  take: RuleTake = plainTake,
): Promise<boolean> {
  if (item.kind !== 'flag') return false;
  const [, lane, ...target] = item.key.split(':');
  if (lane === undefined || target.length < 2) return false;
  for (const other of FLAG_LANES) {
    if (other === lane) continue;
    const key = `flag:${other}:${target.join(':')}`;
    const [open] = await take(1, (n) =>
      ctx.db
        .query('inboxItems')
        .withIndex('by_key', (q) => q.eq('key', key).eq('status', 'open'))
        .take(n),
    );
    if (!open) continue;
    const [mine] = await take(1, (n) =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_item_filer', (q) =>
          q.eq('itemId', open._id).eq('filedByUserId', viewerId).eq('status', 'open'),
        )
        .take(n),
    );
    if (mine !== undefined) return true;
  }
  return false;
}

/** What an ask's decision by `verb` would close of the viewer's own asks (absent: not asked). */
function alongsideFor(verb: InboxVerb, facts: InboxRuleFacts): AlongsideAnswer {
  const a =
    verb === 'approve' || verb === 'sameAs'
      ? facts.askedAlongside?.approve
      : verb === 'decline'
        ? facts.askedAlongside?.decline
        : undefined;
  return a ?? 'clear';
}

/** Whether an ask's decision by `verb` would close one of the viewer's own asks in another item. */
function askedAlongsideFor(verb: InboxVerb, facts: InboxRuleFacts): boolean {
  return alongsideFor(verb, facts) === 'own';
}

/** The refusal of a decision whose reach over the viewer's own asks couldn't be checked. */
function uncheckedRefusal(verb: InboxVerb, facts: InboxRuleFacts): string | null {
  return alongsideFor(verb, facts) === 'unchecked' ? ALONGSIDE_UNCHECKED : null;
}

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
    case 'pin':
      // The pin's own refusals (`setOfficialImpl`): pinned already, or withdrawn (D248).
      if (!facts.alert) return 'This alert is gone.';
      if (facts.alert.status === 'official') return ALERT_PINNED_ALREADY;
      return facts.alert.status === 'retracted' ? ALERT_RETRACTED_NO_PIN : null;
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
      return facts.requestKind === 'name_landmark' && facts.hasLookalike ? null : SAME_AS_REFUSAL;
    case 'lookUpAgain':
      return facts.requestKind === 'admit' ? null : 'Only an admit is looked up in the catalog.';
    case 'mergeDrawn':
      if (!facts.hasOverlap) return NO_OVERLAP_REFUSAL;
      return facts.mergeListsRefusal ?? null;
    default:
      return null;
  }
}

/**
 * The refusal code of a precondition (B01-5d), where a client must act on which refusal it is: a
 * place ask's *Approve* waiting on a bay or a landmark not drawn yet — `awaitsDrawing`, where the
 * handler offers *Draw in Body →*. Asked only of the refusal that answered (rule 5's), so a viewer
 * refused by an earlier rule never gets the code.
 */
export function preconditionCode(
  verb: InboxVerb,
  facts: InboxRuleFacts,
): InboxCanCode[InboxVerb] | undefined {
  if (verb !== 'approve') return undefined;
  if (facts.requestKind === 'name_bay' && facts.bayMissing) return 'awaitsDrawing';
  if (facts.requestKind === 'name_landmark' && facts.landmarkMissing) return 'awaitsDrawing';
  return undefined;
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
  /** How a list row reads (charged to its page's budget); an item's read reads plainly. */
  take: RuleTake = plainTake,
): Promise<InboxCan> {
  return (await inboxCanWithCodes(ctx, viewer, item, facts, take)).can;
}

/**
 * {@link inboxCan} with each refused verb's code beside it (`canCode`, B01-5d) — the code of the rule
 * that answered, and only where a code exists — so a client tells refusals apart without their words.
 */
export async function inboxCanWithCodes(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  item: RuleItem,
  facts?: InboxRuleFacts,
  take: RuleTake = plainTake,
): Promise<{ can: InboxCan; canCode: InboxCanCode }> {
  const filed = await filedByViewer(ctx, item._id, viewer._id);
  const verbs = verbsOf(item, facts ?? {});
  const onTarget =
    !filed && verbs.some((v) => CLOSES_EVERY_LANE.has(v))
      ? await filedOnTarget(ctx, item, viewer._id, take)
      : false;
  const can: InboxCan = {};
  const canCode: InboxCanCode = {};
  for (const verb of verbs) {
    const theirs =
      filed || (onTarget && CLOSES_EVERY_LANE.has(verb)) || askedAlongsideFor(verb, facts ?? {});
    const earlier =
      whoRefusal(viewer, item, verb, theirs, facts) ?? uncheckedRefusal(verb, facts ?? {});
    const precondition = earlier === null && facts ? preconditionRefusal(verb, facts) : null;
    can[verb] = earlier ?? precondition;
    const code =
      precondition !== null && facts
        ? preconditionCode(verb, facts)
        : // A drawing's own drawer refused its merge: the code the merge's preview gives (D289).
          item.kind === 'drawn' && verb === 'mergeDrawn' && earlier === OWN_DRAWING.refusal
          ? OWN_DRAWING.code
          : undefined;
    if (code !== undefined) canCode[verb] = code;
  }
  return { can, canCode };
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
    (CLOSES_EVERY_LANE.has(verb) && (await filedOnTarget(ctx, item, viewer._id))) ||
    askedAlongsideFor(verb, facts);
  return (
    whoRefusal(viewer, item, verb, filed, facts) ??
    uncheckedRefusal(verb, facts) ??
    preconditionRefusal(verb, facts)
  );
}

/**
 * Rules 1–4 and the reach check alone (no precondition): who may decide this item by `verb` — for a
 * write that must ask them **before** its own preconditions, as the rule orders them (a decision's
 * first check, `lib/requestDecisions.assertMayDecide`'s `stage: 'who'`), so a staffer who filed the
 * ask hears so, never an ask's state they couldn't act on anyway.
 */
export async function inboxWhoRefusal(
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
    (CLOSES_EVERY_LANE.has(verb) && (await filedOnTarget(ctx, item, viewer._id))) ||
    askedAlongsideFor(verb, facts);
  return whoRefusal(viewer, item, verb, filed, facts) ?? uncheckedRefusal(verb, facts);
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
