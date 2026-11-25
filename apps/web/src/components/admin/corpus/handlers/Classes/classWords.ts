/**
 * Board 4.3's words, and every word the board did not supply (marked *invented*, for the copy pass).
 * What each class would do is the server's (core's `classConsequence`): words about what the app
 * does with the body, never about its ice (D3). Nothing here says anything about the ice either.
 */
export const CLASS_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────────────
  title: 'Class conflict',
  openInBody: 'Open in Body',
  ladder: 'What each class would do',
  classHead: 'Class',
  consequenceHead: 'What choosing it does',
  now: 'Now',
  suggested: 'Suggested',
  theCatalogs: 'The catalogs',
  theBody: 'The body',
  name: 'Name',
  noName: 'None in any catalog',
  depth: 'Depth',
  noneOnFile: 'None on file',
  attached: 'Attached',
  nearest: 'Nearest',
  setAs: (cls: string) => `Set as ${cls}`,

  // ── Invented ────────────────────────────────────────────────────────────────────────────────────
  keepAs: (cls: string) => `Keep as ${cls}`,
  /** A catalog's claim stored before the campaign that carries its code and area. */
  codeNotRecorded: 'its code and area not recorded until the next campaign',
  acres: (ac: string) => `${ac} ac`,
  meters: (m: string) => `${m} m`,
  /** Which depth is on file: the maximum, else the mean (the Water tab's two columns). */
  measure: { max: 'max', mean: 'mean' },
  /** What changed when a settled class is asked again (D305). */
  classChanged: 'a catalog’s class',
  bar: 'Class conflict',
  whatSet: 'Sets the picked class; the catalogs’ own claims stay on the record.',
  whatKeep: 'Keeps the body’s class; the question is settled until a catalog’s class changes.',
  pickAClass: 'Pick the class',
  /** The receipts (what the decision does, present tense) and the refusal's subject. */
  receiptSet: (cls: string) => `Set as ${cls}`,
  receiptKept: (cls: string) => `Kept as ${cls}`,
  receiptSettled: 'Settled until a catalog’s class changes',
  theDecision: 'The decision',

  // ── The nearest body's offset (the board's *Osmore Pond · 1.1 mi north*) ─────────────────────────────
  /** Middle to middle: from inside the body's water to inside the neighbor's. */
  nearestAt: (name: string, offset: string) => `${name} · ${offset}`,
  /** The board's shape; one decimal under ten miles, whole miles past. */
  milesWay: (miles: string, way: string) => `${miles} mi ${way}`,
  /** Invented: middles so close a direction would be noise. */
  underATenth: 'under 0.1 mi',
  /** The eight directions, as the board writes *north*. */
  compass: {
    N: 'north',
    NE: 'northeast',
    E: 'east',
    SE: 'southeast',
    S: 'south',
    SW: 'southwest',
    W: 'west',
    NW: 'northwest',
  },
} as const;
