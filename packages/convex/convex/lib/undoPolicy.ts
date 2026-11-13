/**
 * The undo registry (D226, B01 §11): for every audited verb, what undoes it.
 *
 * An undo runs the verb's **inverse through the same internal path the forward action uses**, so the
 * side effects run again too (a post's restore brings back the reports it hid; a sub-area redraw
 * re-stamps; a lifted ban unlocks Clerk). Nothing here patches a row back from a snapshot.
 *
 * Each rule says:
 * - `undo`: how the action is undone —
 *   - `inverse`: a different verb that already exists (`hide` → `restore`);
 *   - `setPrev`: the same setter, given the value the row recorded as `prev`;
 *   - `remove`: soft-remove what the action created;
 *   - `later`: the inverse arrives with the workstream that draws its screen (B01 §8);
 *   - `none`: not undoable, and the dialog says why before the action runs;
 * - `takesAway(value)`: whether *setting* this value takes something away from skaters — D226's reason
 *   rule. An undo asks a reason when the value it puts back takes something away;
 * - `capability`: what the person undoing must hold (D217). Undo is never shown to someone who could
 *   not perform the inverse.
 *
 * `undoPolicy.test.ts` holds the table exhaustive over `MODERATION_ACTIONS`.
 */

import type { Capability } from '@skating/core';
import type { ModerationAction, ModerationTargetType } from './audit';

export type Workstream = '§2 Inbox' | '§3 Body console' | '§4 Corpus' | '§6 Season';

/**
 * What an operator is told a `later` undo waits on: the console mode it arrives with, in plain words.
 * The workstream token is the plan's bookkeeping; a reason shown in History or a toast never carries
 * a plan token (no `§`, no D#).
 */
export const WORKSTREAM_MODE: Record<Workstream, string> = {
  '§2 Inbox': 'the Inbox',
  '§3 Body console': 'the Body console',
  '§4 Corpus': 'Corpus',
  '§6 Season': 'the Season page',
};

export type UndoKind =
  | { kind: 'inverse'; inverse: ModerationAction | 'priorStatus' }
  | { kind: 'setPrev' }
  | { kind: 'remove' }
  | { kind: 'later'; workstream: Workstream; plan: string }
  | { kind: 'none'; why: string };

export interface UndoRule {
  undo: UndoKind;
  /** Whether putting this value in place takes something away from skaters (D226). */
  takesAway: (value?: unknown) => boolean;
  /** What the undoer must hold — per target where a verb is shared across kinds. */
  capability: Capability | ((targetType: ModerationTargetType) => Capability);
}

/**
 * The shared verbs (`hide`, `remove`, `restore`) act on content and on corpus objects alike; the
 * lever is the target's, not the verb's.
 */
const byTarget = (targetType: ModerationTargetType): Capability => {
  switch (targetType) {
    case 'waterbody':
      return 'body.remove';
    case 'waterBodySubArea':
      return 'body.shape';
    case 'bodyLandmark':
      return 'body.places';
    case 'putIn':
    case 'parkingArea':
      return 'body.access';
    default:
      return 'content.moderate';
  }
};

/** The capability an undo of `row` needs. */
export function undoCapability(rule: UndoRule, targetType: ModerationTargetType): Capability {
  return typeof rule.capability === 'function' ? rule.capability(targetType) : rule.capability;
}

const always = () => true;
const never = () => false;

const inverse = (verb: ModerationAction | 'priorStatus'): UndoKind => ({
  kind: 'inverse',
  inverse: verb,
});
const setPrev: UndoKind = { kind: 'setPrev' };
const remove: UndoKind = { kind: 'remove' };
const later = (workstream: Workstream, plan: string): UndoKind => ({
  kind: 'later',
  workstream,
  plan,
});

export const UNDO_POLICY: Record<ModerationAction, UndoRule> = {
  // ── Content (reports, posts, comments, hazards, photos; sub-areas and landmarks share the verbs) ──
  hide: { undo: inverse('restore'), takesAway: always, capability: byTarget },
  remove: { undo: inverse('restore'), takesAway: always, capability: byTarget },
  restore: { undo: inverse('priorStatus'), takesAway: never, capability: byTarget },
  author_delete: {
    undo: {
      kind: 'none',
      why: "The author deleted this, and an author's deletion is final: nothing brings it back.",
    },
    takesAway: always,
    capability: 'content.moderate',
  },
  // An overturn takes a verdict off a person's record; putting it back is a new verdict, with its
  // own reason, not an undo (D248).
  overturn_verdict: {
    undo: { kind: 'none', why: 'To put the verdict back, record it again with Hide or Remove.' },
    takesAway: never,
    capability: 'content.moderate',
  },
  // Erased is gone: nothing is left to put back (D248).
  erase: {
    undo: { kind: 'none', why: 'This was erased, so there is nothing left to bring back.' },
    takesAway: always,
    capability: 'content.moderate',
  },

  // The reporter's own "it's open" (founder ruling, 2026-11-13): theirs to say, not a moderator's to
  // take back. A moderator who thinks it still stands pins it again.
  author_resolve_access_alert: {
    undo: {
      kind: 'none',
      why: 'The person who reported it marked it open again. Pin it again if it still stands.',
    },
    takesAway: never,
    capability: 'access.alert',
  },

  // ── People ──────────────────────────────────────────────────────────────────────────────────────
  ban: { undo: inverse('unban'), takesAway: always, capability: 'people.discipline' },
  suspend: { undo: inverse('unban'), takesAway: always, capability: 'people.discipline' },
  unban: { undo: setPrev, takesAway: never, capability: 'people.discipline' },
  set_posting_permission: {
    undo: setPrev,
    // Restricting takes a right away; restoring it, or raising a bounty limit, gives one back.
    takesAway: (allowed) => allowed === false || allowed === 0,
    capability: 'people.discipline',
  },
  grant_role: { undo: setPrev, takesAway: always, capability: 'people.role' },
  revoke_role: { undo: setPrev, takesAway: always, capability: 'people.role' },
  // Ledger editing (D227): only a holder gives or takes it, so only a holder undoes either. Giving it
  // asks no reason; taking it does — so undoing a grant asks why, and undoing a revoke does not.
  grant_ledger_editor: {
    undo: inverse('revoke_ledger_editor'),
    takesAway: never,
    capability: 'machinery.ledger',
  },
  revoke_ledger_editor: {
    undo: inverse('grant_ledger_editor'),
    takesAway: always,
    capability: 'machinery.ledger',
  },

  // ── Bodies ──────────────────────────────────────────────────────────────────────────────────────
  merge_waterbody: {
    undo: later('§4 Corpus', 'Unmerge from the moved-row change set recorded in auditSnapshots.'),
    takesAway: always,
    capability: 'corpus.duplicates',
  },
  dismiss_duplicate: {
    undo: later('§4 Corpus', 'Re-flag the group from the prior dedupStatus recorded as prev.'),
    takesAway: never,
    capability: 'corpus.duplicates',
  },
  approve_waterbody: {
    undo: later('§2 Inbox', 'Back to pending review.'),
    takesAway: never,
    capability: 'inbox.drawnBody',
  },
  reject_waterbody: {
    undo: later('§2 Inbox', 'Back to pending review (the RestoreGate dead end, fixed).'),
    takesAway: always,
    capability: 'inbox.drawnBody',
  },
  // A boost value never takes anything away by itself; but a boost can wake a shelved body, and
  // undoing that boost shelves it again — the handler asks a reason in that case (undoHandlersBody).
  set_curated_boost: { undo: setPrev, takesAway: never, capability: 'body.identity' },
  set_reference_links: { undo: setPrev, takesAway: never, capability: 'body.identity' },
  set_water_body_name: { undo: setPrev, takesAway: never, capability: 'body.identity' },
  set_included_by_request: {
    undo: setPrev,
    takesAway: (included) => included === false,
    capability: 'body.standing',
  },
  set_standing: {
    undo: setPrev,
    takesAway: (standing) => standing !== 'active',
    capability: 'body.standing',
  },
  // The machine's standing rows undo like a person's: the rule reads the standing put back.
  activate_body: {
    undo: setPrev,
    takesAway: (standing) => standing !== 'active',
    capability: 'body.standing',
  },
  demote_body: {
    undo: setPrev,
    takesAway: (standing) => standing !== 'active',
    capability: 'body.standing',
  },
  set_weather_sample_points: { undo: setPrev, takesAway: never, capability: 'body.water' },
  set_lake_depth: { undo: setPrev, takesAway: never, capability: 'body.water' },
  set_satellite_imagery: {
    undo: setPrev,
    // `off` withholds the link (D70/D75); `auto` and `on` give it.
    takesAway: (mode) => mode === 'off',
    capability: 'body.water',
  },

  // ── Requests and flags ──────────────────────────────────────────────────────────────────────────
  approve_request: {
    undo: later('§2 Inbox', 'Reopen the request; the body-side row undoes on its own.'),
    takesAway: never,
    capability: 'inbox.request',
  },
  decline_request: {
    undo: later('§2 Inbox', 'Reopen the request.'),
    takesAway: always,
    capability: 'inbox.request',
  },
  resolve_flag: {
    undo: later(
      '§2 Inbox',
      'Reopen the flag; the verdict message is canceled inside the settle window.',
    ),
    takesAway: always,
    capability: 'inbox.flag',
  },
  dismiss_flag: {
    undo: later(
      '§2 Inbox',
      'Reopen the flag; the verdict message is canceled inside the settle window.',
    ),
    takesAway: never,
    capability: 'inbox.flag',
  },

  // ── Hazards, features, recurrence ───────────────────────────────────────────────────────────────
  promote_body_feature: {
    undo: inverse('demote_body_feature'),
    takesAway: never,
    capability: 'corpus.preIce',
  },
  demote_body_feature: {
    undo: later('§3 Body console', 'Reactivate the feature and re-supersede its source hazard.'),
    takesAway: always,
    capability: 'corpus.preIce',
  },
  promote_recurrence: {
    undo: inverse('demote_body_feature'),
    takesAway: never,
    capability: 'corpus.preIce',
  },
  suppress_recurrence: {
    undo: inverse('unsuppress_recurrence'),
    takesAway: always,
    capability: 'corpus.preIce',
  },
  unsuppress_recurrence: {
    undo: inverse('suppress_recurrence'),
    takesAway: never,
    capability: 'corpus.preIce',
  },
  merge_hazards: {
    undo: inverse('unmerge_hazards'),
    takesAway: always,
    capability: 'corpus.preIce',
  },
  unmerge_hazards: {
    undo: later(
      '§4 Corpus',
      'Merge the pair again through lib/hazardMerge with the operator as actor.',
    ),
    takesAway: never,
    capability: 'corpus.preIce',
  },

  // ── Sub-areas ───────────────────────────────────────────────────────────────────────────────────
  create_sub_area: { undo: remove, takesAway: never, capability: 'body.shape' },
  redraw_sub_area: { undo: setPrev, takesAway: never, capability: 'body.shape' },
  rename_sub_area: { undo: setPrev, takesAway: never, capability: 'body.shape' },

  // ── Access ──────────────────────────────────────────────────────────────────────────────────────
  set_put_in: {
    undo: later(
      '§3 Body console',
      'A new put-in is hidden; an edited one gets its prior name back.',
    ),
    takesAway: never,
    capability: 'body.access',
  },
  set_parking_area: {
    undo: later(
      '§3 Body console',
      'Lot removal and edit are new in the Access tab; undo uses them.',
    ),
    takesAway: never,
    capability: 'body.access',
  },
  set_approach_kind: { undo: setPrev, takesAway: never, capability: 'body.access' },
  set_posted_access: { undo: setPrev, takesAway: never, capability: 'body.access' },
  pin_access_alert: {
    undo: inverse('unpin_access_alert'),
    takesAway: never,
    capability: 'access.alert',
  },
  unpin_access_alert: {
    undo: inverse('pin_access_alert'),
    takesAway: never,
    capability: 'access.alert',
  },
  retract_access_alert: {
    undo: later('§2 Inbox', 'Return the alert to the status it had before retraction.'),
    takesAway: always,
    capability: 'access.alert',
  },
  set_public_access: {
    undo: setPrev,
    // D226: ruling a body closed takes it off the active map and asks why; ruling it open does not.
    takesAway: (access) =>
      typeof access === 'object' &&
      access !== null &&
      (access as { verdict?: string }).verdict === 'none',
    capability: 'access.rule',
  },

  // ── Landmarks ───────────────────────────────────────────────────────────────────────────────────
  create_landmark: { undo: remove, takesAway: never, capability: 'body.places' },
  edit_landmark: { undo: setPrev, takesAway: never, capability: 'body.places' },
  promote_landmark: {
    undo: later(
      '§3 Body console',
      'Restore the landmark; the bay drawn from it stays unless removed too.',
    ),
    takesAway: never,
    capability: 'body.places',
  },
};

/** The verbs whose undo is still owed by a later workstream — the register the build closes. */
export function undoOwed(): { action: ModerationAction; workstream: Workstream; plan: string }[] {
  return (Object.entries(UNDO_POLICY) as [ModerationAction, UndoRule][]).flatMap(
    ([action, rule]) =>
      rule.undo.kind === 'later'
        ? [{ action, workstream: rule.undo.workstream, plan: rule.undo.plan }]
        : [],
  );
}
