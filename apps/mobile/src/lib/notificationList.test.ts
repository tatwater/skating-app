import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeNotification, NOTIFICATION_TYPES } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_LIST_ARGS } from './notificationList';

describe('the inbox screen’s list arguments (B01-5c)', () => {
  it('say this build words every type its own core has — a moderator’s decision among them', () => {
    expect(NOTIFICATION_LIST_ARGS.knows).toEqual([...NOTIFICATION_TYPES]);
    expect(NOTIFICATION_LIST_ARGS.knows).toContain('moderator_decision');
    // Claimed only because it is so: this build's core words the type the server will now send it.
    expect(
      describeNotification({
        id: 'n1',
        createdAt: 1,
        type: 'moderator_decision',
        about: 'restore',
        outcome: 'approved',
        body: { id: 'b1', name: 'Lake Morey' },
      }).title,
    ).toBe('Gli put Lake Morey back on the map');
  });

  it('are what the screen passes to `notifications.list`', () => {
    // No screen renders under this suite yet (`vitest.config.ts`), so the wiring is read off the
    // screen's source: the list query takes these arguments, not an empty object.
    const screen = readFileSync(
      fileURLToPath(new URL('../../app/notifications.tsx', import.meta.url)),
      'utf8',
    );
    expect(screen).toMatch(
      /usePaginatedQuery\(\s*api\.notifications\.list,\s*NOTIFICATION_LIST_ARGS,/,
    );
  });
});
