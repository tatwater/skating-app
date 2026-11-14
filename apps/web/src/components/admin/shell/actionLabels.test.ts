import { describe, expect, it } from 'vitest';
import { actionLabel, actorWords } from './actionLabels';

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

  it('says what became of withdrawn content, and whose word closed a pinned alert', () => {
    expect(actionLabel('erase', 'comment')).toBe('Erased a comment');
    expect(actionLabel('overturn_verdict', 'report')).toBe('Overturned the verdict on a report');
    // Quoting the skater's button: a bare "open" would read as the alert reopened.
    expect(actionLabel('author_resolve_access_alert', 'accessAlert')).toBe(
      'The reporter said “It’s open” on a pinned access alert',
    );
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

describe('actorWords', () => {
  const sarah = { displayName: 'Sarah Berman', username: 'sarah' };

  it('names staff by first name, an author acting on their own in full, the machine by none', () => {
    expect(actorWords(sarah, 'hide')).toBe('Sarah');
    expect(actorWords(sarah, 'author_delete')).toBe('Sarah Berman');
    expect(actorWords(sarah, 'author_resolve_access_alert')).toBe('Sarah Berman');
    expect(actorWords(null, 'activate_body')).toBeNull();
  });

  it('falls back to the username when no display name is set', () => {
    expect(actorWords({ displayName: '  ', username: 'rtremblay' }, 'hide')).toBe('rtremblay');
  });
});
