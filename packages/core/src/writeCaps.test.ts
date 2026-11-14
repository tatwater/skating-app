import { describe, expect, it } from 'vitest';
import {
  FLAG_NOTE_MAX_CHARS,
  IDEMPOTENCY_KEY_MAX_CHARS,
  PHOTO_CAPTION_MAX_CHARS,
  tooLongMessage,
} from './writeCaps';

describe('tooLongMessage — a cap at the write, said so a person can act on it', () => {
  it('lets text up to the cap through, and nothing at all', () => {
    expect(tooLongMessage('The caption', undefined, 10)).toBeNull();
    expect(tooLongMessage('The caption', '', 10)).toBeNull();
    expect(tooLongMessage('The caption', 'x'.repeat(10), 10)).toBeNull();
  });

  it('refuses one character past, with how long it is and what to cut it to', () => {
    expect(tooLongMessage('The note', 'x'.repeat(1_001), 1_000)).toBe(
      'The note is 1,001 characters. Shorten it to 1,000 or fewer.',
    );
  });

  it('holds the founder-approved defaults', () => {
    expect([PHOTO_CAPTION_MAX_CHARS, FLAG_NOTE_MAX_CHARS, IDEMPOTENCY_KEY_MAX_CHARS]).toEqual([
      500, 1_000, 128,
    ]);
  });
});
