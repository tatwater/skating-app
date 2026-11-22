/**
 * The embed's own words — the hover plates' kickers no board supplied — in one place for the copy
 * pass (the Inbox keeps every unsupplied word in a words module). Nouns for what a mark is; never a
 * word about the ice.
 */
export const INBOX_MAP_WORDS = {
  reportPoint: 'Report point',
  asked: 'Asked here',
  lookalike: 'Lookalike',
  putIn: 'Put-in',
  lot: 'Lot',
  alertPutIn: 'Put-in · this alert',
  alertLot: 'Lot · this alert',
} as const;

/**
 * The item map's words (`ItemMap`): the board's legend words (2.3, 2.5) and the honest notes on a
 * short answer, which no board supplied (invented, for the copy pass).
 */
export const ITEM_MAP_WORDS = {
  // From the boards.
  candidateLegend: 'Catalog outline · not ours yet',
  oursLegend: 'Ours',
  ours: 'ours',
  drawn: 'Drawn',
  onTheShore: 'on the shore',
  /** 2.3's legend: the asker's skate ("Kate Donovan's skate"). */
  skateOf: (name: string) => `${name}’s skate`,
  /** 2.5's legend: the skate the drawing was made from ("The recorded skate · 11 Oct"). */
  recordedSkate: 'The recorded skate',
  // Invented.
  unnamed: 'Unnamed',
  noCandidate: 'No catalog feature',
  simplified: 'Outline simplified',
  /** A track the server thinned to fit the map: drawn, never as if every point were there. */
  trackSimplified: 'Skate simplified',
  /** 2.3's legend for several asks' skates, or one whose asker isn't named. */
  skates: 'Recorded skates',
  aSkate: 'A recorded skate',
  capped: 'Not everything is shown',
  failed: 'The map didn’t load',
  loading: 'Loading the map',
} as const;
