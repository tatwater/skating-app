/**
 * **Words for the facts the People server sends that the person page draws since B01-4i** — the
 * body an open flag is on, an appeal's own words, who undid a staffer's decisions; and since B01-4j
 * the levers' facts (since when a right is off and ledger editing held, this season's bounty asks,
 * a profile that opens private). Kept beside
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

  // ── The levers' facts (B01-4j) ──
  /** Under a right that is off, and under ledger editing: when it began. */
  since: (date: string) => `Since ${date}`,
  sinceUnrecorded: 'Since: not recorded yet',
  /** It began before the rows one read walks back (`rightsSinceCapped`, `ledger.sinceCapped`). */
  sinceTooOld: 'Since: older than what one read covers',
  /** Under the bounty limit: this season's asks, from the create gate's record. */
  seasonAsks: (asks: string, over: string, recent: string) =>
    `This season: ${asks}, ${over} over the limit, ${recent} turned away for a recent report`,
  /** A count of asks: "1 ask", "4 asks", "500+ asks". */
  asks: (n: string, one: boolean) => `${n} ${one ? 'ask' : 'asks'}`,
  noSeasonAsks: 'No bounty asks this season',
  /** The season began before the gate's 180-day record: not the whole season, so nothing shown as it. */
  seasonAsksUnrecorded: 'This season’s asks: not recorded yet',
  /** The head's link when the profile opens to their name and picture only. */
  privateProfile: 'Private profile',
} as const;
