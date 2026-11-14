import { describe, expect, it } from 'vitest';
import { POSITIVE_REACTION_KINDS, positiveReactionOf } from './reactions';

describe('positive reactions (the founder, 2026-11-13)', () => {
  it('counts a helpful rating as kudos', () => {
    expect(positiveReactionOf('helpful')).toBe('helpful');
  });

  it('never counts a thumbs-down, or a verdict it has no word for', () => {
    expect(positiveReactionOf('unhelpful')).toBeNull();
    expect(positiveReactionOf('')).toBeNull();
  });

  it('knows every kind it lists', () => {
    for (const kind of POSITIVE_REACTION_KINDS) expect(positiveReactionOf(kind)).toBe(kind);
  });
});
