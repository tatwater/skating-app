/**
 * Board 2.2's words, and every word the board did not supply (marked *invented* for the copy
 * pass). A ruling says *accessible*, never *open* (the board's rule); nothing here says anything
 * about the ice (D3).
 */
export const ACCESS_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────
  lane: 'Access reports',
  disputes: 'Disputes a ruling',
  openInBody: 'Open in Body',
  sayNoAccess: 'Say no access',
  /** The ruling's cited reason, as the board's line starts. */
  source: 'Source:',
  skaters: 'skaters',
  skater: 'skater',
  sinceRuling: 'Since the ruling',
  ruledAccessible: 'Ruled accessible',
  daysAgo: 'days ago',
  dayAgo: 'day ago',
  claimsAndRuling: 'The claims and the ruling',
  standingRuling: 'Standing ruling',
  dismissedByThatRuling: 'dismissed by that ruling',
  ifNoAccess: 'If no public access',
  ifAccessible: 'If confirmed accessible',
  body: 'Body',
  reports: 'Reports',
  ruling: 'Ruling',
  reason: 'Reason',
  dimmedOffMap: 'Dimmed, off the active map',
  unchanged: 'Unchanged',
  reportersTold: 'reporters told',
  closed: 'closed',
  dismissed: 'Dismissed',
  askedWhenChosen: 'Asked for when you choose it',
  reDatedToday: 'Re-dated today',
  noPublicAccess: 'No public access',
  confirmAccessible: 'Confirm accessible',
  clearAccessible: 'Clear the accessible ruling',
  bar: 'Ruling',

  // ── Invented (the board draws only a dispute of an accessible ruling) ────────────────────────
  /** The head's badge for reports after a standing no-public-access ruling. */
  afterNoAccess: 'After a no-access ruling',
  /** The third stat with no ruling yet. */
  noRulingYet: 'No ruling yet',
  ruledNoAccess: 'Ruled no public access',
  /** Under the third stat with no ruling: why it is empty. */
  firstReports: 'First reports on this body',
  /** The contest-access asks' stat (the board's *Say accessible*, worded as what it counts). */
  askAccessible: 'Ask for access back',
  contestingIt: 'Contesting the ruling',
  /** The stat's sub-line naming who ruled. */
  by: 'By',
  /** The ruling event when the person who ruled is gone. */
  someoneGone: 'A former moderator',
  /** The two *If* blocks with no standing ruling, or after a no-access one. */
  newRuling: 'The first on this body',
  replaces: (date: string) => `Replaces ${date}’s`,
  backOnMap: 'Back on the active map',
  stillOff: 'Stays off the active map',
  clearNoAccess: 'Clear the no-access ruling',
  /** The reports a ruling dismissed, as one timeline event. */
  reportsDismissed: (n: number) =>
    `${n === 1 ? '1 report' : `${n} reports`} · dismissed by that ruling`,
  /** Each button's tooltip (the bar has no explaining line). */
  whatNoAccess: 'Takes the body off the active map and closes these reports. Asks a reason.',
  whatAccessible: 'Rules the body accessible and dismisses these reports.',
  whatClear: 'Removes the standing ruling; the reports stay open.',
  /** The reason dialog. */
  askTitle: (body: string) => `No public access · ${body}`,
  askDescription:
    'The body dims on the map and drops out of every push, and each reporter hears the verdict. Skaters read the ruling and its date.',
  askLabel: 'Reason · kept in History',
  /** The receipts and the refusal's subject (the Body console's words). */
  receiptNone: 'Ruled no public access',
  receiptOpen: 'Ruled accessible',
  receiptClear: 'Cleared the ruling',
  /** A receipt's second line (invented): what the ruling did to the reports. */
  closedPast: 'closed',
  dismissedPast: 'dismissed',
  reportsStayOpen: 'The reports stay open, in the lane',
  reporterTold: 'the reporter told',
  noneToClose: 'No report was open to close',
  noneToDismiss: 'No report was open to dismiss',
  theRuling: 'The ruling',
  /** A reporter's standing on their line. */
  pts: 'pts',
  filedByApp: 'Filed by the app',
  /** The map's caption. */
  mapCaption: 'The body and its access points',
} as const;
