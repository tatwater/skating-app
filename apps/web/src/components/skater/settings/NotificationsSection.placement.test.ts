import { NOTIFICATION_PREF_LABELS, NOTIFICATION_PREF_ORDER } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { NOTIFICATION_GROUPS } from './NotificationsSection';

/**
 * Where a moderator's decision sits on the settings page (B01-5c): in *Moderation and recording*,
 * right after the flag ruling it is a sibling of — the order core gives every client, so the phone
 * and the web list the toggles alike.
 */
describe('the moderator’s-decision toggle', () => {
  it('reads the groups in core’s order, every key once', () => {
    expect(NOTIFICATION_GROUPS.flatMap((g) => g.keys)).toEqual([...NOTIFICATION_PREF_ORDER]);
  });

  it('sits in Moderation and recording, after the flag ruling', () => {
    const group = NOTIFICATION_GROUPS.find((g) => g.keys.includes('moderatorDecision'));
    expect(group?.title).toBe('Moderation and recording');
    const keys = group?.keys ?? [];
    expect(keys.indexOf('moderatorDecision')).toBe(keys.indexOf('contentFlagResolved') + 1);
    // Its words are core's (the label the copy pass owns), never this page's.
    expect(NOTIFICATION_PREF_LABELS.moderatorDecision).toBeTruthy();
  });
});
