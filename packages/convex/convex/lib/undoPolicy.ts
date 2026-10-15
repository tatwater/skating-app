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
import type { ModerationAction } from './audit';

export type Workstream = '§2 Inbox' | '§3 Body console' | '§4 Corpus' | '§6 Season';

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
  capability: Capability;
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
  hide: { undo: inverse('restore'), takesAway: always, capability: 'content.moderate' },
  remove: { undo: inverse('restore'), takesAway: always, capability: 'content.moderate' },
  restore: { undo: inverse('priorStatus'), takesAway: never, capability: 'content.moderate' },
  author_delete: {
    undo: {
      kind: 'none',
      why: "The author's own takedown; a moderator restores the content with restore.",
    },
    takesAway: always,
    capability: 'content.moderate',
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
  activate_body: { undo: setPrev, takesAway: never, capability: 'body.standing' },
  demote_body: { undo: setPrev, takesAway: always, capability: 'body.standing' },
  set_weather_sample_points: { undo: setPrev, takesAway: never, capability: 'body.water' },
  set_lake_depth: { undo: setPrev, takesAway: never, capability: 'body.water' },
  set_satellite_imagery: {
    undo: setPrev,
    takesAway: (mode) => mode === 'never',
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
      'Reopen the flag; the verdict message is cancelled inside the settle window.',
    ),
    takesAway: always,
    capability: 'inbox.flag',
  },
  dismiss_flag: {
    undo: later(
      '§2 Inbox',
      'Reopen the flag; the verdict message is cancelled inside the settle window.',
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
