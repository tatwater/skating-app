import { describe, expect, it } from 'vitest';
import { actionLabel } from './actionLabels';

describe('actionLabel', () => {
  it('names the target for the shared content verbs', () => {
    expect(actionLabel('hide', 'report')).toBe('Hid a report');
    expect(actionLabel('restore', 'waterBodySubArea')).toBe('Restored a sub-area');
    expect(actionLabel('remove', 'user')).toBe('Removed an account');
  });

  it('says a verb that names its own subject as is', () => {
    expect(actionLabel('set_curated_boost', 'waterbody')).toBe('Set the curated boost');
    expect(actionLabel('decline_request', 'waterBodyRequest')).toBe('Declined a request');
  });

  it('never shows a code name or a placeholder', () => {
    for (const [a, t] of [
      ['ban', 'user'],
      ['merge_hazards', 'hazard'],
      ['set_public_access', 'waterbody'],
    ] as const) {
      const label = actionLabel(a, t);
      expect(label).not.toMatch(/_|\{t\}/);
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
  });
});
