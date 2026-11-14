import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DELETION_GRACE_DAYS } from './profile';
import {
  alertRetractionByAuthor,
  flagRetraction,
  nextEraseAt,
  requestRetraction,
  WITHDRAWN_ERASE_DAYS,
  WITHDRAWN_ERASE_MS,
} from './withdrawal';

const DAY = 24 * 60 * 60 * 1000;

describe('the erasure clock', () => {
  it('is the same 30 days as an account deletion (the founder set them equal)', () => {
    expect(WITHDRAWN_ERASE_DAYS).toBe(DELETION_GRACE_DAYS);
    expect(WITHDRAWN_ERASE_MS).toBe(30 * DAY);
  });

  it('starts at the withdrawal, stops while held, and never runs for what was not withdrawn', () => {
    const at = Date.UTC(2026, 11, 1, 12);
    expect(nextEraseAt({ withdrawnAt: at, held: false, current: undefined, now: at })).toBe(
      at + 30 * DAY,
    );
    expect(nextEraseAt({ withdrawnAt: at, held: true, current: at + 30 * DAY, now: at })).toBe(
      undefined,
    );
    expect(nextEraseAt({ withdrawnAt: undefined, held: false, current: undefined, now: at })).toBe(
      undefined,
    );
  });

  it('a hold that clears late erases at the clearing; one that clears early, at the 30 days', () => {
    const at = Date.UTC(2026, 11, 1, 12);
    const late = at + 45 * DAY;
    expect(nextEraseAt({ withdrawnAt: at, held: false, current: undefined, now: late })).toBe(late);
    const early = at + 3 * DAY;
    expect(nextEraseAt({ withdrawnAt: at, held: false, current: undefined, now: early })).toBe(
      at + 30 * DAY,
    );
  });

  it('re-reading a running clock never moves it', () => {
    const at = Date.UTC(2026, 11, 1, 12);
    expect(
      nextEraseAt({ withdrawnAt: at, held: false, current: at + 30 * DAY, now: at + 29 * DAY }),
    ).toBe(at + 30 * DAY);
  });

  /**
   * The invariant, over any order of holds landing and clearing after a withdrawal: whatever
   * happened, the item is due exactly when nothing holds it, and never before both the 30 days and
   * the moment its last hold cleared.
   */
  it('is never due before 30 days, nor before the last hold cleared, nor while held', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.array(fc.record({ gap: fc.integer({ min: 0, max: 60 * DAY }), hold: fc.boolean() }), {
          maxLength: 12,
        }),
        (withdrawnAt, events) => {
          let now = withdrawnAt;
          let held = false;
          let lastCleared = withdrawnAt;
          let clock = nextEraseAt({ withdrawnAt, held, current: undefined, now });
          for (const { gap, hold } of events) {
            now += gap;
            if (held && !hold) lastCleared = now;
            held = hold;
            clock = nextEraseAt({ withdrawnAt, held, current: clock, now });
          }
          if (held) {
            expect(clock).toBeUndefined();
          } else {
            expect(clock).toBeDefined();
            expect(clock).toBeGreaterThanOrEqual(withdrawnAt + WITHDRAWN_ERASE_MS);
            expect(clock).toBeGreaterThanOrEqual(lastCleared);
          }
        },
      ),
    );
  });
});

describe('retraction until decided', () => {
  it('a request: only while open', () => {
    expect(requestRetraction('open')).toBe('retract');
    expect(requestRetraction('approved')).toBe('decided');
    expect(requestRetraction('declined')).toBe('decided');
    expect(requestRetraction('retracted')).toBe('already');
  });

  it("a flag: a person's own, while open or picked up, and not once others share it", () => {
    expect(flagRetraction({ status: 'open', origin: 'user' })).toBe('retract');
    expect(flagRetraction({ status: 'reviewing', origin: 'user', occurrences: 1 })).toBe('retract');
    expect(flagRetraction({ status: 'actioned', origin: 'user' })).toBe('decided');
    expect(flagRetraction({ status: 'dismissed', origin: 'user' })).toBe('decided');
    expect(flagRetraction({ status: 'retracted', origin: 'user' })).toBe('already');
    expect(flagRetraction({ status: 'open', origin: 'auto' })).toBe('notYours');
    expect(flagRetraction({ status: 'open' })).toBe('notYours');
    expect(flagRetraction({ status: 'open', origin: 'user', occurrences: 2 })).toBe('sharedFlag');
  });

  it('an access alert, by its author: only a live community claim no moderator ever pinned', () => {
    expect(alertRetractionByAuthor('active', false)).toBe('retract');
    expect(alertRetractionByAuthor('official', true)).toBe('confirmed');
    // Released since: a moderator still confirmed it existed.
    expect(alertRetractionByAuthor('active', true)).toBe('confirmed');
    expect(alertRetractionByAuthor('resolved', false)).toBe('closed');
    expect(alertRetractionByAuthor('expired', false)).toBe('closed');
    // Closed is closed, pinned once or not — e.g. the author's own "it's open" settled the pin.
    expect(alertRetractionByAuthor('resolved', true)).toBe('closed');
    expect(alertRetractionByAuthor('expired', true)).toBe('closed');
    expect(alertRetractionByAuthor('retracted', true)).toBe('already');
  });
});
