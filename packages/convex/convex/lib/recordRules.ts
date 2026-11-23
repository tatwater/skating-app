/**
 * **What a moderator may do to an item on a person's record, decided once** (B01-4d, the People
 * record sheet; D248). The sheet's four levers — Restore, Hide again, Overturn and Keep on the record —
 * are each one write, and each write refuses through {@link recordRefusal}; the sheet's reads answer
 * their `can` from the same function over the same facts, so a lever is never drawn that its write
 * turns down ("one rule, one answer", D217).
 *
 * - **Restore** (`moderation.setModerationStatus`, `visible`): an item a moderator hid or removed that
 *   is still its author's. Never content its author deleted (D248 Part A), never what was erased; a
 *   Post that would come back with none of its Reports needs a choice of which come back with it, or
 *   can't come back at all when its author deleted every one. A give-back: no reason asked.
 * - **Hide again** (`setModerationStatus`, `hidden`): an item that is up — restored in this sitting.
 *   A takeaway: a reason, always.
 * - **Overturn** (`moderation.overturnVerdict`): a decision on content its author has since deleted
 *   (or an alert they retracted). The decision leaves their record; the content stays deleted and its
 *   erasure clock runs again. A reason only if there is one to give.
 * - **Keep on the record** (`moderation.keepOnRecord`): content they deleted that no decision holds
 *   yet — recorded as a removal (an alert, as a retraction), which holds it from erasure until it is
 *   overturned. A takeaway: a reason, always.
 *
 * Who may pull a lever is the write capability (`content.moderate`, or `access.alert` for an alert),
 * and never an operator on their way out (D62) — the words the person page uses.
 */
import { canUse, isLeaving } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import { AUTHOR_DELETED_RESTORE, authorDeletedAtOf } from './authorDeletion';
import type { VerdictTargetType } from './contentVerdicts';
import { authorRetracted } from './eraseClock';
import { authorOf, ownContentRefusal } from './ownContent';

/** What a verdict decided: a hide, a removal, an alert's retraction (the schema's own literals). */
export type VerdictKind = Doc<'contentVerdicts'>['kind'];

/** Anything a moderator tries on an item the sweep erased. */
export const ERASED_ALREADY = 'This was erased, so there is nothing left to act on.';
/** An overturn on content still its author's: Restore is the way back. */
export const OVERTURN_NOT_DELETED =
  'Its author still has this up. Restore it to take the verdict off their record.';
export const OVERTURN_NOTHING_STANDING = 'There is no standing verdict on this to overturn.';
/** A restore of what is already up: nothing would change, so nothing is written. */
export const RESTORE_ALREADY_UP = 'This is already up.';
/** A keep on content its author hasn't taken back: that is an ordinary hide or removal. */
export const KEEP_NOT_DELETED =
  'Its author hasn’t deleted this. Hide or remove it to put it on their record.';
/**
 * A hide or removal of what a decision of that kind already holds: nothing would change, so nothing is
 * written (D270, as D267's restore of what is up) — whatever the reason given, as a keep already held.
 */
export const TAKEDOWN_ALREADY = {
  hidden: 'This is already hidden.',
  removed: 'This is already removed.',
} as const;
/**
 * Restore or Hide again on an access alert: no write moves an alert's moderation status — it is pinned,
 * released or retracted (`accessAlerts`), and a decision on one is overturned or kept.
 */
export const ALERT_HAS_NO_STATUS =
  'An access alert is pinned, released or retracted, not hidden or restored.';
/** A keep on content a decision already holds: nothing would change. */
export const KEEP_ALREADY_HELD = 'A decision already keeps this on their record.';
/** A forward restore that would bring the Post back with none of its Reports (founder, 2026-11-13). */
export const POST_RESTORE_NEEDS_A_CHOICE =
  'Every report in this post was hidden or removed on its own. Choose at least one report to restore with it.';
/** Every member is withdrawn by its author, or gone: nothing can come back, so the Post can't. */
export const POST_UNRESTORABLE =
  "Every report in this post was deleted by its author, so the post can't be restored.";
/** An undo that would do the same: undo never chooses, so it points at Restore. */
export const UNDO_LEAVES_POST_EMPTY =
  'Undoing this would show the post with none of its reports. Restore the post instead and choose which reports come back with it.';
/** A lever an operator in their own deletion window can't pull (D62) — the person page's words. */
export const RECORD_LEAVING = 'Your account is being deleted, so you can no longer change this.';
/** A viewer without the lever's capability. */
export const RECORD_NOT_STAFF = 'Only a moderator can change this.';
/**
 * A list row's answer for a lever its list can't afford to decide: a Post's members decide whether it
 * can come back and how, and a page of Posts can't read ten Reports each. The item's own read
 * (`contentRecord.item`) answers it. Never an offer, so never a lever the write would refuse.
 */
export const RECORD_CHECK_ON_ITEM = 'Open it to see what can be done with it.';

export type RecordAction = 'restore' | 'hideAgain' | 'overturn' | 'keep';

/** A lever's answer: `Can`, and on a Post's restore whether the moderator must choose its Reports. */
export type RecordCan =
  | { ok: true; needsReason: boolean; needsChoice?: boolean }
  | { ok: false; why: string };

/** What a Post's restore would do, as `moderation.planPostRestore` read it. */
export interface PostRestoreFacts {
  /** Members the restore would leave visible without a choice. */
  visibleAfter: number;
  /** Members a moderator could choose to bring back. */
  choosable: number;
}

/**
 * Everything the rule reads of an item — from documents the caller already holds; never a read of
 * its own. `withdrawn` is `'unknown'` only for a Post its author didn't delete whose members weren't
 * read (a list row): whether every member was withdrawn decides between Restore and Overturn.
 */
export interface RecordFacts {
  targetType: VerdictTargetType;
  /** Gone, or a comment the sweep reduced to its placeholder. */
  erased: boolean;
  /** Gone altogether (no document): nothing to act on, not even an overturn. */
  gone?: boolean;
  /** Its author deleted it (the stamp), or retracted their alert. */
  authorDeleted: boolean;
  /**
   * Its author took it back: {@link RecordFacts.authorDeleted}, or a Post every Report of which its
   * author deleted (the clients delete Reports, never a whole Post) — what an overturn asks. A photo
   * is `'unknown'` where its uploader's withdrawal wasn't read (a list row).
   */
  withdrawn: boolean | 'unknown';
  /** `visible`, `hidden` or `removed` — an alert's moderation axis is its retraction, so `null`. */
  status: Doc<'reports'>['moderationStatus'] | null;
  /** A moderator's verdict stands on it. */
  standing: boolean;
  /**
   * The kind of the verdict standing on it — `null` with none (`standing` says the same). A takedown
   * of the kind already held may change nothing ({@link takedownRefusal}).
   */
  heldAs: VerdictKind | null;
  /** A Post's restore plan, when its members were read; absent otherwise. */
  post?: PostRestoreFacts;
  /**
   * A Post's Reports up now, when its members were read; absent otherwise. A takedown of a Post with
   * one up still takes that one down, so it is a change even where a decision of its kind holds.
   */
  membersUp?: number;
  /** Who wrote it (a hazard's or alert's filer); `null` when gone. A moderator never decides their own (D269). */
  authorId: Id<'profiles'> | null;
}

/** The write capability a lever on this kind takes. */
export function recordCapability(
  targetType: VerdictTargetType,
): 'content.moderate' | 'access.alert' {
  return targetType === 'accessAlert' ? 'access.alert' : 'content.moderate';
}

/** Whether `action` asks a reason (D226): a takeaway does; a give-back may take one. */
export const RECORD_NEEDS_REASON: Record<RecordAction, boolean> = {
  restore: false,
  hideAgain: true,
  overturn: false,
  keep: true,
};

/**
 * **Why the item refuses `action`, or `null`** — the writes refuse by it and the reads' `can` answer
 * by it. A Post's restore whose members weren't read answers {@link RECORD_CHECK_ON_ITEM} (a read's
 * answer only: the write always reads the members); one that would show no Report answers
 * {@link POST_RESTORE_NEEDS_A_CHOICE} — the plan counts the Reports a write chose, so a write with a
 * choice passes — which `can` turns into `needsChoice`.
 */
export function recordRefusal(facts: RecordFacts, action: RecordAction): string | null {
  // An erased comment's shell keeps its record: a decision standing on it can still come off it
  // (Overturn); nothing else is left to act on. An item gone altogether has nothing to act on at all.
  if (facts.gone || (facts.erased && action !== 'overturn')) return ERASED_ALREADY;
  switch (action) {
    case 'restore': {
      if (facts.targetType === 'accessAlert') return ALERT_HAS_NO_STATUS;
      if (facts.authorDeleted) return AUTHOR_DELETED_RESTORE;
      // A photo whose uploader's withdrawal wasn't read (a list row) may be theirs to keep down.
      if (facts.targetType === 'photo' && facts.withdrawn === 'unknown') {
        return RECORD_CHECK_ON_ITEM;
      }
      // Up already: nothing to change — unless a decision still stands on it (a history rebuilt from
      // before the record), which the restore ends.
      if (facts.status === 'visible' && !facts.standing) return RESTORE_ALREADY_UP;
      if (facts.targetType !== 'post') return null;
      if (facts.post === undefined) return RECORD_CHECK_ON_ITEM;
      if (facts.post.visibleAfter > 0) return null;
      return facts.post.choosable === 0 ? POST_UNRESTORABLE : POST_RESTORE_NEEDS_A_CHOICE;
    }
    case 'hideAgain':
      return takedownRefusal(facts, 'hidden');
    case 'overturn':
      if (facts.withdrawn === 'unknown') return RECORD_CHECK_ON_ITEM;
      if (!facts.withdrawn) return OVERTURN_NOT_DELETED;
      return facts.standing ? null : OVERTURN_NOTHING_STANDING;
    case 'keep':
      if (!facts.authorDeleted) return KEEP_NOT_DELETED;
      return facts.standing ? KEEP_ALREADY_HELD : null;
  }
}

/**
 * **Why a hide or a removal of the item would be refused, or `null`** (B01-4h) — Hide again's answer
 * (`hidden`) and the write's own (`moderation.setModerationStatus`, both kinds), one function: a
 * takedown of what a decision of that kind already holds changes nothing, so it writes nothing (D270,
 * as D267's restore of what is up) — unless it still moves the content: the item is not yet at that
 * status, or it is a Post with a Report still up (taken down with it). On content its author deleted
 * the decision is all a takedown writes (the content stays as the deletion left it), so one already
 * held is refused whatever the status. A Post whose members weren't read answers
 * {@link RECORD_CHECK_ON_ITEM} where they would decide. An alert has no status to take down.
 */
export function takedownRefusal(facts: RecordFacts, status: 'hidden' | 'removed'): string | null {
  if (facts.gone || facts.erased) return ERASED_ALREADY;
  if (facts.targetType === 'accessAlert') return ALERT_HAS_NO_STATUS;
  if (facts.heldAs !== status) return null;
  if (facts.authorDeleted) return TAKEDOWN_ALREADY[status];
  if (facts.status !== status) return null;
  if (facts.targetType === 'post') {
    if (facts.membersUp === undefined) return RECORD_CHECK_ON_ITEM;
    if (facts.membersUp > 0) return null;
  }
  return TAKEDOWN_ALREADY[status];
}

/** The viewer as the rule reads them: their role, their grant, whether they are on their way out. */
export type RecordViewer = Pick<
  Doc<'profiles'>,
  '_id' | 'role' | 'canEditLedger' | 'deletionRequestedAt'
>;

/**
 * **Why `viewer` may not decide on this item at all** — before the item's own state is asked: the
 * lever's capability and leaving ({@link viewerRefusal}), then their own content (D269,
 * `lib/ownContent`). The levers ({@link recordCan}) and the writes refuse by this one function.
 */
export function recordActorRefusal(viewer: RecordViewer, facts: RecordFacts): string | null {
  return viewerRefusal(viewer, facts.targetType) ?? ownContentRefusal(viewer, facts.authorId);
}

/** Whether `viewer` holds the lever at all, and if not why — before the item is asked. */
export function viewerRefusal(viewer: RecordViewer, targetType: VerdictTargetType): string | null {
  if (canUse(viewer.role, isLeaving(viewer), recordCapability(targetType), viewer)) return null;
  return isLeaving(viewer) ? RECORD_LEAVING : RECORD_NOT_STAFF;
}

/** `viewer`'s answer for `action` on the item: the capability first, then {@link recordRefusal}. */
export function recordCan(
  viewer: RecordViewer,
  facts: RecordFacts,
  action: RecordAction,
): RecordCan {
  const who = recordActorRefusal(viewer, facts);
  if (who !== null) return { ok: false, why: who };
  const why = recordRefusal(facts, action);
  if (why === POST_RESTORE_NEEDS_A_CHOICE) {
    return { ok: true, needsReason: RECORD_NEEDS_REASON[action], needsChoice: true };
  }
  if (why !== null) return { ok: false, why };
  return action === 'restore' && facts.targetType === 'post'
    ? { ok: true, needsReason: false, needsChoice: false }
    : { ok: true, needsReason: RECORD_NEEDS_REASON[action] };
}

/** The levers an item's state offers, each with this viewer's answer — only the ones that apply. */
export type RecordLevers = Partial<Record<RecordAction, RecordCan>>;

/**
 * **Which levers apply to the item as it stands** (the sheet's one action per item): a decision that
 * stands on content still its author's — Restore; on content they took back since — Overturn; content
 * they took back that no decision holds — Keep on the record; content that is up — Hide again. An
 * erased item offers nothing, and an alert is never restored (only overturned or kept). A Post whose
 * members weren't read and whose author didn't delete it answers Restore with
 * {@link RECORD_CHECK_ON_ITEM} (its members decide between the two).
 */
export function recordLevers(viewer: RecordViewer, facts: RecordFacts): RecordLevers {
  const answer = (action: RecordAction) => ({ [action]: recordCan(viewer, facts, action) });
  if (facts.gone) return {};
  if (facts.erased) return facts.standing ? answer('overturn') : {};
  if (facts.standing) {
    if (facts.withdrawn === true) return answer('overturn');
    // An alert has no moderation status to restore (`setModerationStatus` takes no alert): its one
    // verdict is on an alert its author retracted, which `withdrawn` sends to Overturn above.
    if (facts.status === null) return {};
    return answer('restore');
  }
  if (facts.authorDeleted) return answer('keep');
  if (facts.status === 'visible') return answer('hideAgain');
  return {};
}

type ContentDoc = Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'>;

/**
 * The facts of an item from its document (or `null`, gone) and the kind of the verdict standing on it
 * (`null`: none). A Post its author didn't delete is `withdrawn: 'unknown'` unless `members` says
 * whether every one of its Reports was withdrawn; `post` carries its restore plan and `membersUp`
 * how many of its Reports are up, where they were read. A photo's withdrawal by its uploader is not on
 * its document (`lib/photoAccess.photoWithdrawnAt` reads it): `photoWithdrawn` carries it, and every
 * caller building a photo's facts passes it (`photoRecordFacts`), so a lever and its write agree.
 */
export function recordFactsOf(
  targetType: VerdictTargetType,
  doc: ContentDoc | Doc<'accessAlerts'> | Doc<'photos'> | null,
  heldAs: VerdictKind | null,
  members?: {
    everyWithdrawn?: boolean;
    plan?: PostRestoreFacts;
    up?: number;
    photoWithdrawn?: boolean;
  },
): RecordFacts {
  const standing = heldAs !== null;
  if (doc === null) {
    return {
      targetType,
      erased: true,
      gone: true,
      authorDeleted: false,
      withdrawn: false,
      status: null,
      standing,
      heldAs,
      authorId: null,
    };
  }
  if (targetType === 'accessAlert') {
    const retracted = authorRetracted(doc as Doc<'accessAlerts'>);
    return {
      targetType,
      erased: false,
      authorDeleted: retracted,
      withdrawn: retracted,
      status: null,
      standing,
      heldAs,
      authorId: authorOf(doc),
    };
  }
  if (targetType === 'photo') {
    // A purged photo is a tombstone (D222): its bytes are gone, its row names what was removed — as
    // an erased comment's shell, only a standing decision can still come off it.
    // A list row that didn't read the withdrawal answers `unknown`: its levers point at the item.
    const photo = doc as Doc<'photos'>;
    const withdrawn = members?.photoWithdrawn ?? 'unknown';
    return {
      targetType,
      // Purged, or its bytes found gone by a rotation: nothing left to restore (D222).
      erased: photo.purgedAt !== undefined || photo.bytesMissingAt !== undefined,
      authorDeleted: withdrawn === true,
      withdrawn,
      status: photo.moderationStatus ?? 'visible',
      standing,
      heldAs,
      authorId: authorOf(photo),
    };
  }
  const content = doc as ContentDoc;
  const erased = targetType === 'comment' && (content as Doc<'comments'>).erasedAt !== undefined;
  const stamped = authorDeletedAtOf(content) !== undefined;
  const withdrawn =
    stamped || targetType !== 'post' ? stamped : (members?.everyWithdrawn ?? 'unknown');
  return {
    targetType,
    erased,
    authorDeleted: stamped,
    withdrawn,
    status: content.moderationStatus,
    standing,
    heldAs,
    authorId: authorOf(content),
    ...(members?.plan !== undefined && targetType === 'post' ? { post: members.plan } : {}),
    ...(members?.up !== undefined && targetType === 'post' ? { membersUp: members.up } : {}),
  };
}
