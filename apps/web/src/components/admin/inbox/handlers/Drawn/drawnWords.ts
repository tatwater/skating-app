/**
 * Board 2.5's words, and every word the board did not supply (marked *invented* for the copy pass).
 * Nothing here says anything about the ice (D3): a drawing is about where the water is, never what
 * it is like.
 */
export const DRAWN_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────
  title: 'Drawn body',
  fromSkate: 'From a recorded skate',
  openInBody: 'Open in Body',
  overlap: 'Overlap',
  /** The gauge's sub-line: what the share is of. */
  ofTheDrawingIs: (name: string) => `Of the drawing is ${name}`,
  mergeSuggestedFrom: (pct: number) => `Merge suggested from ${pct} %`,
  theReport: 'The report it came from',
  user: 'User',
  trust: 'Trust',
  ifMergedInto: (name: string) => `If merged into ${name}`,
  rowReport: 'Report',
  rowSkater: 'Skater',
  rowDrawing: 'Drawing',
  mergeInto: (name: string) => `Merge into ${name}`,
  approveAsNew: 'Approve as new',
  reject: 'Reject',

  // ── Invented ────────────────────────────────────────────────────────────────────────────────
  /** The head's micro line when no report is linked. */
  drawnByASkater: 'Drawn by a skater',
  /** The report block's rows. */
  skated: 'Skated',
  /** The skate the drawing came from: its row (the board's *Track*; no distance is served). */
  skate: 'Skate',
  /** The report's words withheld from this viewer (hidden, removed, or withdrawn by its author). */
  excerptWithheld: 'Its words aren’t shown: the report is hidden or withdrawn',
  /** The report itself lives in Reports, which isn't built. */
  openInReports: 'Open in Reports',
  /** The drawer's visible reports, after their standing. */
  reports: (n: number) => (n === 1 ? '1 report' : `${n.toLocaleString('en-US')} reports`),
  noReportLinked: 'No report is linked to this drawing',
  /** The drawer gone (a finished deletion). */
  drawerGone: 'A former skater',
  /** The trust row for a departed drawer. */
  noTrust: 'Not shown for a former skater',
  pts: 'pts',
  /** With no overlap: the gauge's place. */
  noOverlap: 'It overlaps no body on the map',
  /** *If merged into*: what moves, each row only where the item serves what it names. */
  mergeReport: 'Re-homed · stays visible',
  /** The skate the drawing came from moves with it (a merge re-points the founding skate). */
  mergeSkate: 'Kept · moves with it',
  /** The drawer is told of the merge (never with a reason). */
  mergeTold: 'Told it was merged',
  mergePoints: (name: string) => `Points at ${name}`,
  /** Each button's tooltip (the bar has no explaining line). */
  whatMerge: (name: string) =>
    `Folds the drawing into ${name}: what it holds moves there, and the drawer is told.`,
  whatApprove: 'Lists the drawing as a new body; the drawer is told.',
  whatReject: 'Takes the drawing off the map; the drawer is told. Asks a reason, kept for staff.',
  bar: 'Drawn body',
  /** The reject dialog. */
  rejectTitle: (name: string) => `Reject · ${name}`,
  /**
   * The drawer is told it was rejected, never why: the reason is the audit row's (the server's
   * rejection carries none to the drawer), so the field says so in the console's words.
   */
  rejectDescription:
    'The drawing comes off the map and the drawer is told. Say why, for the record.',
  rejectLabel: 'Reason · kept in the audit log',
  /** The receipts (what each does, present tense) and the refusal's subject. */
  approved: 'Approved as new',
  approvedDetail: 'Lists it on the map · tells the drawer',
  rejected: 'Rejected',
  rejectedDetail: 'Takes it off the map · tells the drawer',
  /** The merge's receipt names both bodies: the survivor here, the drawing as its subject. */
  mergedInto: (name: string) => `Merged into ${name}`,
  mergedDetail: 'Moves what the drawing holds · tells the drawer',
  theDecision: 'The decision',
} as const;
