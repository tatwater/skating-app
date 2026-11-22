import { INBOX_DECISIONS } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { COINED, DECISION_WORDS, occurrence } from './inboxWords';

/** The decisions whose words a board drew; every other decision's word is coined. */
const FROM_BOARDS = new Set([
  'dismissed',
  'hidden',
  'removed',
  // Board 2.6's life strip draws an alert *pinned*.
  'pinned',
  'unpinned',
  'no public access',
  'confirmed accessible',
  'approved',
  'merged',
  'rejected',
  'resolved',
]);

describe('the decision words', () => {
  it('names every decision the server can write, so a new one can’t ship blank', () => {
    for (const d of INBOX_DECISIONS) {
      const word = DECISION_WORDS[d];
      expect(typeof word, d).toBe('string');
      expect(word.trim(), d).not.toBe('');
      // Said as a moderator says it: never the stored token.
      expect(word, d).not.toMatch(/_/);
    }
    expect(Object.keys(DECISION_WORDS).sort()).toEqual([...INBOX_DECISIONS].sort());
  });

  it('lists every word no board drew for the copy pass', () => {
    for (const word of Object.values(DECISION_WORDS)) {
      if (!FROM_BOARDS.has(word)) expect(COINED, word).toContain(word);
    }
  });
});

describe('an occurrence', () => {
  it('takes its ordinal', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(occurrence)).toEqual([
      '1st occurrence',
      '2nd occurrence',
      '3rd occurrence',
      '4th occurrence',
      '11th occurrence',
      '12th occurrence',
      '13th occurrence',
      '21st occurrence',
      '22nd occurrence',
      '101st occurrence',
      '111th occurrence',
    ]);
  });
});
