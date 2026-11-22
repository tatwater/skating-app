import { countOf } from '../../words/inboxWords';

/**
 * Board 2.4's words, and every word the board did not supply (marked *invented* for the copy pass):
 * a landmark ask with a lookalike is the board's; a bay ask, an ask with no lookalike and the
 * several-asker case are invented. Nothing here says anything about the ice (D3): a place ask is
 * about a name on the map, never about what the ice there is like.
 */
export const PLACE_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────
  titleLandmark: 'Name a landmark',
  openInReports: 'Open in Reports',
  /** The note over the where: from a report's *where* line. */
  fromWhere: (who: string, when: string) => `From the where of ${who}’s report, ${when}:`,
  where: 'Where',
  user: 'User',
  trust: 'Trust',
  samePlace: 'Same place?',
  sameName: 'same name',
  apart: (distance: string) => `${distance} apart`,
  theAsk: 'The ask',
  name: 'Name',
  kind: 'Kind',
  point: 'Point',
  alsoCalled: 'Also called',
  usedBy: 'Used by',
  landmark: 'Landmark',
  nothingYet: 'Nothing yet',
  noAliases: 'No aliases',
  noReportsYet: 'No reports yet',
  reports: (n: number) => (n === 1 ? '1 report' : `${n} reports`),
  ifSamePlace: 'If same place',
  ifDrawn: 'If drawn',
  gainsAlias: (name: string) => `Gains the alias “${name}”`,
  rowReport: 'Report',
  snaps: 'Its where snaps to the landmark',
  asker: 'Asker',
  creditedTold: 'Credited and told',
  samePlaceButton: 'Same place',
  drawInBody: 'Draw in Body',
  decline: 'Decline',

  // ── Invented ────────────────────────────────────────────────────────────────────────────────
  titleBay: 'Name a bay',
  openInBody: 'Open in Body',
  /** A lookalike's source, after its name in the column head. */
  source: {
    osm: 'OpenStreetMap',
    gnis: 'GNIS',
    corpus: 'The community’s emails',
    moderator: 'Added by a moderator',
    proposal: 'A skater’s ask',
  } as Record<string, string>,
  usedByUnknown: 'Not recorded',
  /** Another open ask near this one, by a similar name (a proposal lookalike). */
  anotherAsk: (name: string, distance: string) =>
    `Another open ask nearby: “${name}” · ${distance}`,
  /** A bay or landmark ask with nobody to compare it to. */
  noLookalike: 'Nothing on this body looks like the same place.',
  askedBy: 'Asked by',
  /** The person gone. */
  formerSkater: 'A former skater',
  noTrust: 'Not shown for a former skater',
  /**
   * The asker's landmark asks, by the byline (the board's "3 landmarks named"): how many of their
   * asks a landmark answered, of how many they made — floors ("50+") where the count stopped.
   */
  landmarksAdded: (added: string, asked: string) => `${added} of ${asked} landmark asks added`,
  firstLandmarkAsk: 'first landmark ask',
  pts: 'pts',
  /** *If drawn*: the old editor, while the console's map tools are not built. */
  opens: 'Opens',
  oldEditorNewTab: 'The old editor · in a new tab',
  thenLabel: 'Then',
  approveThere: 'Approve it there, or here once it is drawn',
  /** *If approved*: an ask the place already answers (a bay drawn, a landmark there). */
  ifApproved: 'If approved',
  answeredBy: 'Answered by',
  theBayDrawn: 'The bay already drawn',
  theLandmarkThere: 'The landmark already there',
  /** *If declined*. */
  ifDeclined: 'If declined',
  closes: 'Closes',
  asksClosed: (n: number, floor: boolean) =>
    floor ? `${countOf(n, true)} asks` : n === 1 ? 'The ask' : `All ${countOf(n)} asks`,
  toldWithNote: 'Told, with your note',
  approve: 'Approve',
  /** Each button's tooltip (the bar has no explaining line). */
  whatSamePlace: 'Answers the ask with the landmark already there; the asker is told.',
  whatDraw: 'Opens the old editor in a new tab, to draw the place; approve it once drawn.',
  whatApprove: 'Answers the ask with the place already drawn; the asker is told.',
  whatDecline: 'Closes the ask; the asker reads your note.',
  bar: 'Place ask',
  /** The decline dialog. */
  declineTitle: (name: string) => `Decline “${name}”`,
  declineDescription: 'Every ask for this place closes, and each asker reads your note.',
  declineLabel: 'Note · the asker reads it',
  /** The receipts (what each does, present tense) and the refusal's subject. */
  receiptSamePlace: 'Same place',
  receiptApproved: 'Approved',
  receiptDeclined: 'Declined',
  closesAsks: (n: number, floor: boolean) =>
    floor
      ? `Closes ${countOf(n, true)} asks`
      : n === 1
        ? 'Closes 1 ask'
        : `Closes ${countOf(n)} asks`,
  theDecision: 'The decision',
} as const;
