/**
 * **Words for the facts the People server sends that the person page draws since B01-4i** — the
 * body an open flag is on, an appeal's own words, who undid a staffer's decisions. Kept beside
 * `personWords` (the page's other coined words) for the founder to read together; none of them is
 * a board's.
 *
 * Never "You", never a pronoun for a person, never a word about the ice.
 */
export const FACT_WORDS = {
  // ── Open about this person ──
  /** Some open flags on content carry no body's name: past what one read names. */
  flagLabelsCapped: 'Some flags here don’t say which body they’re on: more than one read names',
  /** A person's own words bounded to a few lines: the press that shows them all, and back. */
  showAll: 'Show all',
  showLess: 'Show less',

  // ── The staff strip ──
  /** Followed by who: "2 later undone by ‹Ada›, ‹Bo› and 1 more". */
  undoneByNamed: (n: string) => `${n} later undone by`,
  /** The last of a list of people: those the read counted but didn't name. */
  andMore: (n: number) => `${n} more`,
  and: 'and',
} as const;
