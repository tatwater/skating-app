import { CAPABILITIES } from '@skating/core';
import { describe, expect, test } from 'vitest';
import { MODERATION_ACTIONS } from './enums';
import { UNDO_POLICY, undoOwed } from './undoPolicy';

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
    for (const rule of Object.values(UNDO_POLICY))
      expect(CAPABILITIES[rule.capability].write).toBe(true);
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
  });

  test('the owed register names a workstream and a plan for each', () => {
    const owed = undoOwed();
    expect(owed.length).toBeGreaterThan(0);
    for (const o of owed) expect(o.plan.length).toBeGreaterThan(10);
  });
});
