/**
 * The undo registry (D226, B01 §11): for every audited verb, what undoes it.
 *
 * An undo runs the verb's **inverse through the same internal path the forward action uses**, so the
 * side effects run again too (a post's restore brings back the reports it hid; a sub-area redraw
 * re-stamps; a lifted ban unlocks Clerk). An inverse may restore the fields the forward write
 * changed, from before-values it recorded (`auditSnapshots`), through the forward paths' side
 * effects — never a bare patch of a row back to its snapshot that skips them (D291). A redraw's undo
 * puts its outline back through the setter; the unmerge (`unmerge.ts`) re-points each moved row as
 * the merge did (a report's bay join re-mirrored, an ask or a flag re-keyed into its Inbox item),
 * puts back on each bay and landmark only the fields the merge wrote — and only while each still
 * holds the merge's value — then re-cells, re-names and re-stamps both bodies, and recomputes every
 * derived fact through the path that keeps it.
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

import { type Capability, effectiveBountyLimitOf, ROLE_RANK, type UserRole } from '@skating/core';
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

/** Whether a role change `{ from, to }` moves the person down. */
function roleDown(value?: unknown): boolean {
  const { from, to } = (value ?? {}) as { from?: UserRole; to?: UserRole };
  return from !== undefined && to !== undefined && ROLE_RANK[to] < ROLE_RANK[from];
}
const never = () => false;

/** Whether a pin list moving `{ from, to }` drops any pin `from` held. */
function pinRemoved(value?: unknown): boolean {
  const { from, to } = (value ?? {}) as { from?: readonly string[]; to?: readonly string[] };
  return Array.isArray(from) && from.some((k) => !(to ?? []).includes(k));
}

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
    undo: {
      kind: 'none',
      why: 'To put the verdict back, record it again: Hide or Remove, or Retract on an alert.',
    },
    takesAway: never,
    // The lever the overturn itself takes: an alert's is the alert lever (`moderation.overturnVerdict`).
    capability: (targetType) =>
      targetType === 'accessAlert' ? 'access.alert' : 'content.moderate',
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
      why: 'The person who reported it said it has cleared. Pin it again if it still stands.',
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
    // Restricting takes a right away (flagging included, D222); restoring it gives one back. A bounty
    // limit takes away when it lowers the limit in force: `{ from, to }`, each a limit or `null` for
    // the global cap.
    takesAway: (value) => {
      if (typeof value === 'object' && value !== null && 'to' in value) {
        const { from, to } = value as { from: number | null; to: number | null };
        return effectiveBountyLimitOf(to) < effectiveBountyLimitOf(from);
      }
      return value === false;
    },
    capability: 'people.discipline',
  },
  // A demotion asks why; a promotion does not (D226; the founder, 2026-11-14). `{ from, to }`.
  grant_role: { undo: setPrev, takesAway: roleDown, capability: 'people.role' },
  revoke_role: { undo: setPrev, takesAway: roleDown, capability: 'people.role' },
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
  // The unmerge (B01-5d, D291): from the change set the merge recorded, through the forward paths.
  merge_waterbody: {
    undo: inverse('unmerge_waterbody'),
    takesAway: always,
    capability: 'corpus.duplicates',
  },
  // "Merge it again" is a fresh merge, with its own change set — never an undo of the unmerge.
  unmerge_waterbody: {
    undo: {
      kind: 'none',
      why: 'To put them back together, merge them again.',
    },
    takesAway: never,
    capability: 'corpus.duplicates',
  },
  dismiss_duplicate: {
    undo: later('§4 Corpus', 'Re-flag the group from the prior dedupStatus recorded as prev.'),
    takesAway: never,
    capability: 'corpus.duplicates',
  },
  // Both reviews go back to pending (B01-5): the policy's pure inverse, not the opposite review (D247).
  approve_waterbody: {
    undo: inverse('return_to_review'),
    takesAway: never,
    capability: 'inbox.drawnBody',
  },
  reject_waterbody: {
    undo: inverse('return_to_review'),
    takesAway: always,
    capability: 'inbox.drawnBody',
  },
  // A boost value never takes anything away by itself; but a boost can wake a shelved body, and
  // undoing that boost shelves it again — the handler asks a reason in that case (undoHandlersBody).
  set_curated_boost: { undo: setPrev, takesAway: never, capability: 'body.identity' },
  set_reference_links: { undo: setPrev, takesAway: never, capability: 'body.identity' },
  set_aliases: { undo: setPrev, takesAway: never, capability: 'body.identity' },
  set_class: { undo: setPrev, takesAway: never, capability: 'body.identity' },
  // Removing any pin takes a body out of a town (and maybe a state's filter); only adding gives. The
  // list alone can't tell which, so the value is the move `{ from, to }` — the one rule the forward
  // write and its undo handler both ask, as a role change is.
  set_moderator_towns: { undo: setPrev, takesAway: pinRemoved, capability: 'body.identity' },
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
  choose_depth_source: { undo: setPrev, takesAway: never, capability: 'body.water' },
  // Undoing a show takes a pass from skaters again; undoing a hide gives it back.
  set_imagery_override: {
    undo: setPrev,
    takesAway: (action) => action === 'hide',
    capability: 'machinery.imagery',
  },
  set_satellite_imagery: {
    undo: setPrev,
    // `off` withholds the link (D70/D75); `auto` and `on` give it.
    takesAway: (mode) => mode === 'off',
    capability: 'body.water',
  },

  // ── Requests and flags ──────────────────────────────────────────────────────────────────────────
  // Reopened with every sibling the decision closed (B01-5); an approval's body-side row is undone
  // first, through its own handler and capability.
  approve_request: {
    undo: inverse('reopen_request'),
    takesAway: never,
    capability: 'inbox.request',
  },

  decline_request: {
    undo: inverse('reopen_request'),
    takesAway: always,
    capability: 'inbox.request',
  },

  // Reopened with every flag the decision closed (B01-5); a verdict message still settling is dropped.
  resolve_flag: {
    undo: inverse('reopen_flag'),
    takesAway: always,
    capability: 'inbox.flag',
  },

  dismiss_flag: {
    undo: inverse('reopen_flag'),
    takesAway: never,
    capability: 'inbox.flag',
  },

  // The Inbox's own inverses (B01-5), each undone by deciding again as before: a reopened flag
  // closes with its prior resolution; a reopened decline declines the same asks again. A reopened
  // approval is approved again from the Inbox (its handler says so): undo never re-runs a body act.
  reopen_flag: {
    undo: inverse('priorStatus'),
    takesAway: (resolution) => resolution === 'actioned',
    capability: 'inbox.flag',
  },
  reopen_request: {
    undo: inverse('decline_request'),
    takesAway: never,
    capability: 'inbox.request',
  },
  // Its undo reviews the drawing again as the row it took back had it; a rejection takes it off the
  // map, so putting one back asks why. The value is the review status put in place.
  return_to_review: {
    undo: inverse('priorStatus'),
    takesAway: (reviewStatus) => reviewStatus === 'rejected',
    capability: 'inbox.drawnBody',
  },
  // Its undo retracts the alert again, through the same retraction (which records `prev` anew).
  unretract_access_alert: {
    undo: inverse('retract_access_alert'),
    takesAway: never,
    capability: 'access.alert',
  },

  // ── Hazards, features, recurrence ───────────────────────────────────────────────────────────────
  promote_body_feature: {
    undo: inverse('demote_body_feature'),
    takesAway: never,
    capability: 'corpus.preIce',
  },
  update_body_feature_shape: { undo: setPrev, takesAway: never, capability: 'corpus.preIce' },
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
  // B01-3d: a promotion's undo puts the launch's source and name back (taking official status away,
  // so it asks a reason); the undo of that undo promotes again (giving, so it asks none). A new
  // official point placed by `setOfficial` has no undo yet (its handler refuses that row).
  set_put_in: {
    undo: setPrev,
    takesAway: (direction) => direction !== 'demoted',
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
  // A moderator's retraction of someone else's alert puts it back to the `prev` it recorded (B01-5);
  // one recorded on an alert its author had already retracted is a verdict, reversed by an overturn.
  retract_access_alert: {
    undo: inverse('unretract_access_alert'),
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

  // ── Support (B01-5f, D284) ─────────────────────────────────────────────────────────────────────
  // Notes and replies are staff's words to staff or to the person who filed; none takes anything away
  // from skaters, so no undo asks a reason. A note's removal and its return undo each other; a reply
  // cancels only while it settles (its handler refuses after: "Sent replies can't be unsent"); a
  // resolve and a reopen undo each other.
  support_note: {
    undo: inverse('remove_support_note'),
    takesAway: never,
    capability: 'inbox.support',
  },
  // Its undo puts the note back, writing `support_note` again for the same note.
  remove_support_note: {
    undo: inverse('support_note'),
    takesAway: never,
    capability: 'inbox.support',
  },
  support_reply: {
    undo: inverse('cancel_support_reply'),
    takesAway: never,
    capability: 'inbox.support',
  },
  // A canceled reply was never sent; sending it now would be a new reply, written as one.
  cancel_support_reply: {
    undo: { kind: 'none', why: 'A canceled reply isn’t sent again; write a new one.' },
    takesAway: never,
    capability: 'inbox.support',
  },
  resolve_ticket: {
    undo: inverse('reopen_ticket'),
    takesAway: never,
    capability: 'inbox.support',
  },
  reopen_ticket: {
    undo: inverse('resolve_ticket'),
    takesAway: never,
    capability: 'inbox.support',
  },

  // ── Photos (B01-5e) ────────────────────────────────────────────────────────────────────────────
  // The purge is permanent (§11's *Permanent* row): the bytes are gone, and the removal's dialog says
  // so before it runs. Final, not a placeholder; S5b may refine the words.
  purge_photo: {
    undo: { kind: 'none', why: "The photo's file was deleted 30 days after its removal." },
    takesAway: always,
    capability: 'content.moderate',
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
