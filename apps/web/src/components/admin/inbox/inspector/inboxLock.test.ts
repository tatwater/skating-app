import { describe, expect, it } from 'vitest';

import { decidedStateOf } from './inboxLock';

// Moved from `lockModel.test.ts` with `decidedStateOf` (B01-6a); the field is `decisionWord` now, the
// decision in the Inbox's words.
describe('the Inbox’s decided state', () => {
  it('names the decider, or a former staff member, and an empty action for a decision before the Inbox', () => {
    expect(
      decidedStateOf({
        at: 5,
        by: { userId: 'u' as never, displayName: 'Sarah Berman' },
        decision: 'approved',
        actionId: 'm1' as never,
        byMe: false,
      }),
    ).toEqual({ by: 'Sarah Berman', at: 5, decisionWord: 'approved', byMe: false, actionId: 'm1' });
    expect(
      decidedStateOf({ at: 5, by: null, decision: 'dismissed', actionId: null, byMe: false }),
    ).toMatchObject({ by: 'a former staff member', actionId: '' });
  });
});
