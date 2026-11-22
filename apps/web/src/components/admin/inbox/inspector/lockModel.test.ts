import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decidedStateOf,
  isDecidedPhase,
  LOCK_START,
  type LockSeen,
  type LockState,
  lockSeenOf,
  nextLock,
} from './lockModel';

const open: LockSeen = { item: true, decided: false };
const byOther: LockSeen = { item: true, decided: true, byMe: false };
const byMe: LockSeen = { item: true, decided: true, byMe: true };
const none: LockSeen = { item: false };

const run = (ref: string, ...seen: (LockSeen | undefined)[]): LockState =>
  seen.reduce<LockState>((s, x) => nextLock(s, ref, x), LOCK_START);

describe('the decided-only lock', () => {
  it('stays unread until the read answers', () => {
    expect(run('a', undefined)).toEqual({ ref: 'a', phase: 'none' });
  });

  it('is live while the item is open', () => {
    expect(run('a', open).phase).toBe('live');
  });

  it('locks when a colleague decides it while it is open', () => {
    expect(run('a', open, byOther).phase).toBe('locked');
  });

  it('clears quietly when the viewer decides it while it is open', () => {
    expect(run('a', open, byMe).phase).toBe('quiet');
  });

  it('is a record when it was already decided as it opened, whoever decided it', () => {
    expect(run('a', byOther).phase).toBe('onOpen');
    expect(run('a', byMe).phase).toBe('onOpen');
  });

  it('goes live again when an undo reopens it', () => {
    expect(run('a', open, byOther, open).phase).toBe('live');
    expect(run('a', open, byMe, open).phase).toBe('live');
    expect(run('a', byOther, open).phase).toBe('live');
  });

  it('a lock holds through more answers (a read retried, a re-render)', () => {
    expect(run('a', open, byOther, byOther, undefined, byMe).phase).toBe('locked');
    expect(run('a', open, byMe, byOther).phase).toBe('quiet');
  });

  it('says no such item for a ref to nothing, and gone for one withdrawn while open', () => {
    expect(run('a', none).phase).toBe('missing');
    expect(run('a', none, none).phase).toBe('missing');
    expect(run('a', open, none).phase).toBe('gone');
    expect(run('a', open, byOther, none).phase).toBe('gone');
    expect(run('a', open, none, byOther).phase).toBe('onOpen');
  });

  it('starts over for another ref', () => {
    const locked = run('a', open, byOther);
    expect(nextLock(locked, 'b', undefined)).toEqual({ ref: 'b', phase: 'none' });
    expect(nextLock(locked, 'b', byOther).phase).toBe('onOpen');
  });

  it('keeps the same state object when nothing changes', () => {
    const live = run('a', open);
    expect(nextLock(live, 'a', open)).toBe(live);
  });

  it('never shows the banner for the viewer’s own decision made while open (fast-check)', () => {
    // Any run that went live and then saw the viewer's decision — with retries in between — is
    // quiet, never locked; any run that went live and saw a colleague's first is locked.
    const noise = fc.array(fc.constant<LockSeen | undefined>(undefined), { maxLength: 3 });
    fc.assert(
      fc.property(noise, noise, fc.boolean(), (a, b, mine) => {
        const s = run('a', open, ...a, mine ? byMe : byOther, ...b);
        expect(s.phase).toBe(mine ? 'quiet' : 'locked');
      }),
    );
  });

  it('only decided phases carry a decision (fast-check)', () => {
    const seen = fc.constantFrom<LockSeen | undefined>(open, byOther, byMe, none, undefined);
    fc.assert(
      fc.property(fc.array(seen, { maxLength: 12 }), (xs) => {
        const s = run('a', ...xs);
        const last = xs.filter((x) => x !== undefined).at(-1);
        if (last === undefined) expect(s.phase).toBe('none');
        else if (!last.item) expect(['missing', 'gone']).toContain(s.phase);
        else expect(isDecidedPhase(s.phase)).toBe(last.decided);
      }),
    );
  });
});

describe('the lock’s readings', () => {
  it('reads an item read’s answer', () => {
    expect(lockSeenOf(undefined)).toBeUndefined();
    expect(lockSeenOf(null)).toEqual({ item: false });
    expect(lockSeenOf({ decided: null })).toEqual(open);
    expect(
      lockSeenOf({
        decided: { at: 1, by: null, decision: 'approved', actionId: null, byMe: true },
      }),
    ).toEqual(byMe);
  });

  it('names the decider, or a former staff member, and an empty action for a decision before the Inbox', () => {
    expect(
      decidedStateOf({
        at: 5,
        by: { userId: 'u' as never, displayName: 'Sarah Berman' },
        decision: 'approved',
        actionId: 'm1' as never,
        byMe: false,
      }),
    ).toEqual({ by: 'Sarah Berman', at: 5, decision: 'approved', byMe: false, actionId: 'm1' });
    expect(
      decidedStateOf({ at: 5, by: null, decision: 'dismissed', actionId: null, byMe: false }),
    ).toMatchObject({ by: 'a former staff member', actionId: '' });
  });
});
