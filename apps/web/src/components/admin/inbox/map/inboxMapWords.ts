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
  // Invented.
  unnamed: 'Unnamed',
  noCandidate: 'No catalog feature',
  simplified: 'Outline simplified',
  capped: 'Not everything is shown',
  failed: 'The map didn’t load',
  loading: 'Loading the map',
} as const;
