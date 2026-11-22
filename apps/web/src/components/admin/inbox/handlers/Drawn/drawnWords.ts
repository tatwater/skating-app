/**
 * Board 2.5's words, and every word the board did not supply (marked *invented* for the copy pass).
 * Nothing here says anything about the ice (D3): a drawing is about where the water is, never what
 * it is like. *Merge* is drawn and says *Coming soon* (D286); nothing here offers to merge.
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
  rowDrawing: 'Drawing',
  mergeInto: (name: string) => `Merge into ${name}`,
  approveAsNew: 'Approve as new',
  reject: 'Reject',

  // ── Invented ────────────────────────────────────────────────────────────────────────────────
  /** The head's micro line when no report is linked. */
  drawnByASkater: 'Drawn by a skater',
  /** The report block's rows (the read carries no report's words or track yet). */
  skated: 'Skated',
  noReportLinked: 'No report is linked to this drawing',
  /** The drawer gone (a finished deletion). */
  drawerGone: 'A former skater',
  /** The trust row for a departed drawer. */
  noTrust: 'Not shown for a former skater',
  pts: 'pts',
  /** With no overlap: the gauge's place. */
  noOverlap: 'It overlaps no body on the map',
  /** *If merged into*: what a merge does, never an offer to do it here. */
  mergeReport: 'Re-homed · stays visible',
  mergePoints: (name: string) => `Points at ${name}`,
  /** The merge block's last row: where the merge is, while it isn't here. */
  rowHere: 'Here',
  mergeNotHere: 'Coming soon · the old editor merges it',
  oldEditor: 'Old editor',
  /** Each button's tooltip (the bar has no explaining line). */
  whatMerge: 'Folds the drawing into the body it overlaps.',
  whatApprove: 'Lists the drawing as a new body; the drawer is told.',
  whatReject: 'Takes the drawing off the map; the drawer is told. Asks a reason.',
  bar: 'Drawn body',
  /** The reject dialog. */
  rejectTitle: (name: string) => `Reject · ${name}`,
  rejectDescription:
    'The drawing comes off the map and the drawer is told. Say why — they read it.',
  rejectLabel: 'Reason · the drawer reads it',
  /** The receipts (what each does, present tense) and the refusal's subject. */
  approved: 'Approved as new',
  approvedDetail: 'Lists it on the map · tells the drawer',
  rejected: 'Rejected',
  rejectedDetail: 'Takes it off the map · tells the drawer',
  theDecision: 'The decision',
} as const;
