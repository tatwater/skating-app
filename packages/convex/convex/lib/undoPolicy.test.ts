import { CAPABILITIES } from '@skating/core';
import { describe, expect, test } from 'vitest';
import { MODERATION_ACTIONS } from './enums';
import { UNDO_POLICY, undoCapability, undoOwed, WORKSTREAM_MODE } from './undoPolicy';

describe('the undo registry (D226)', () => {
  test('covers every audited verb, and nothing else', () => {
    expect(Object.keys(UNDO_POLICY).sort()).toEqual([...MODERATION_ACTIONS].sort());
  });

  test('every inverse is itself an audited verb', () => {
    for (const rule of Object.values(UNDO_POLICY)) {
      if (rule.undo.kind === 'inverse' && rule.undo.inverse !== 'priorStatus') {
        expect(MODERATION_ACTIONS).toContain(rule.undo.inverse);
      }
    }
  });

  test('every undo needs a write capability', () => {
    for (const rule of Object.values(UNDO_POLICY)) {
      for (const t of [
        'report',
        'waterbody',
        'waterBodySubArea',
        'bodyLandmark',
        'putIn',
      ] as const) {
        expect(CAPABILITIES[undoCapability(rule, t)].write).toBe(true);
      }
    }
  });

  test('a shared verb takes the lever of its target', () => {
    expect(undoCapability(UNDO_POLICY.remove, 'report')).toBe('content.moderate');
    expect(undoCapability(UNDO_POLICY.remove, 'waterbody')).toBe('body.remove');
    expect(undoCapability(UNDO_POLICY.restore, 'waterBodySubArea')).toBe('body.shape');
    expect(undoCapability(UNDO_POLICY.hide, 'putIn')).toBe('body.access');
  });

  test('a verb that cannot be undone says why', () => {
    for (const rule of Object.values(UNDO_POLICY)) {
      if (rule.undo.kind === 'none') expect(rule.undo.why.length).toBeGreaterThan(20);
    }
  });

  test('taking something away asks a reason; giving it back does not (D226)', () => {
    expect(UNDO_POLICY.hide.takesAway()).toBe(true);
    expect(UNDO_POLICY.restore.takesAway()).toBe(false);
    expect(UNDO_POLICY.set_public_access.takesAway({ verdict: 'none' })).toBe(true);
    expect(UNDO_POLICY.set_public_access.takesAway({ verdict: 'open' })).toBe(false);
    expect(UNDO_POLICY.set_public_access.takesAway(null)).toBe(false);
    expect(UNDO_POLICY.set_posting_permission.takesAway(false)).toBe(true);
    expect(UNDO_POLICY.set_posting_permission.takesAway(true)).toBe(false);
    expect(UNDO_POLICY.set_standing.takesAway('dormant')).toBe(true);
    expect(UNDO_POLICY.set_standing.takesAway('active')).toBe(false);
    // Pins: any pin dropped takes away, a swap included; only adding (or reordering) gives.
    const pins = UNDO_POLICY.set_moderator_towns.takesAway;
    expect(pins({ from: ['a', 'b'], to: ['a'] })).toBe(true);
    expect(pins({ from: ['a'], to: ['b'] })).toBe(true);
    expect(pins({ from: ['a'] })).toBe(true);
    expect(pins({ from: ['a'], to: ['a', 'b'] })).toBe(false);
    expect(pins({ from: ['a', 'b'], to: ['b', 'a'] })).toBe(false);
    expect(pins()).toBe(false);
    expect(UNDO_POLICY.set_satellite_imagery.takesAway('off')).toBe(true);
    expect(UNDO_POLICY.set_satellite_imagery.takesAway('auto')).toBe(false);
    expect(UNDO_POLICY.demote_body.takesAway('active')).toBe(false);
    expect(UNDO_POLICY.activate_body.takesAway('dormant')).toBe(true);
  });

  test('what an operator is told a later undo waits on carries no plan token', () => {
    // Reasons reach History and the toast verbatim; a `§` or a D# is the plan's, never the screen's.
    for (const rule of Object.values(UNDO_POLICY)) {
      if (rule.undo.kind !== 'later') continue;
      expect(WORKSTREAM_MODE[rule.undo.workstream]).toMatch(/^[A-Za-z ]+$/);
    }
  });

  test('the owed register names a workstream and a plan for each', () => {
    const owed = undoOwed();
    expect(owed.length).toBeGreaterThan(0);
    for (const o of owed) expect(o.plan.length).toBeGreaterThan(10);
  });

  test('the Inbox’s inverses are built: none of its §2 rows is still owed, the merge and §3/§4 are', () => {
    const owed = new Set(undoOwed().map((o) => o.action));
    for (const action of [
      'resolve_flag',
      'dismiss_flag',
      'approve_request',
      'decline_request',
      'approve_waterbody',
      'reject_waterbody',
      'retract_access_alert',
      'reopen_flag',
      'reopen_request',
      'return_to_review',
      'unretract_access_alert',
    ] as const) {
      expect(owed.has(action), action).toBe(false);
    }
    expect(owed.has('merge_waterbody')).toBe(true);
    expect(undoOwed().every((o) => o.workstream !== '§2 Inbox')).toBe(true);
  });
});
