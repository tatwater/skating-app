/**
 * **Every word board 2.7 (Content flags · Photo) and the photo's states say** — one module for the
 * founder's copy pass. The board supplied the stage's veil, *On the same report*, the bar and the
 * Remove tooltip; the rest (a viewer who can't see photos, a file already deleted, the dialogs, the
 * record sheet's photo) were written for states no board draws and are listed in the builder's report.
 *
 * Nothing here says or implies anything about the ice (D3). No decision numbers, section marks or
 * phase tokens.
 */

/**
 * **What a takedown does, as the dev proof showed it** (one truth, no switch): a hide or a removal
 * takes the photo off its link at once and shows it to no one — but a device that already opened it
 * may keep its own copy for up to 30 days, which nothing here can reach. So no word claims the photo
 * is gone from everywhere, or erased before its removal's 30 days are up.
 */

/** The days a removed photo waits before its file is deleted (the server's purge clock). */
export const PHOTO_PURGE_DAYS = 30;

export const PHOTO_WORDS = {
  // ── The stage (2.7) ─────────────────────────────────────────────────────────────────────────
  veil: 'Pixelated until you choose to look',
  show: 'Show the photo',
  pixelate: 'Pixelate again',
  /** The stage's accessible name while pixelated: what it is, never what it shows. */
  stageLabel: 'The flagged photo, pixelated',
  /** The revealed image's text alternative: the uploader's caption, else this. */
  photoAlt: 'The flagged photo',
  /** "1 of 4 on the report"; a floor when the read cut the report's list short. */
  ofReport: (n: number, of: string) => `${n} of ${of} on the report`,
  /** No URL served: the viewer can't read photos (`content.read`), so the server sent none. */
  noAccess: 'Photos on flags are shown only to staff who can read hidden content',
  noAccessSub: 'The flag, its author and the levers below are yours to use without it.',
  /** Served no file although the viewer may see it: the blob is gone. */
  noFile: 'The file for this photo couldn’t be found',
  noFileSub: 'The flag and its author are still here to decide on.',
  /** A removal's file, deleted on the purge clock: what was removed, and when. */
  purged: (day: string) => `The file was deleted on ${day}`,
  purgedSub: (removed: string | null) =>
    `${removed === null ? 'It was removed' : `It was removed on ${removed}`}, and ${PHOTO_PURGE_DAYS} days passed without a restore. The decision stays on the uploader’s record.`,
  /** Coined: a takedown's rotation found the file gone (`bytesMissingAt`). */
  missing: 'The file for this photo is missing',
  missingSub: (day: string) =>
    `Found missing on ${day}, so it can’t be restored. The flag and its author are still here to decide on.`,
  /** A removed photo still inside its 30 days. */
  purgeOn: (day: string) => `Its file is deleted on ${day} unless it is restored`,
  /** Coined: its uploader deleted it while a flag or a decision held it (B01-5e's withdrawal). */
  withdrawn: (day: string) =>
    `Its uploader took it down on ${day}; it is kept out of sight while a flag or a decision holds it`,
  /** Coined: the full photo's fetch on Show failed. */
  revealFailed: 'The photo couldn’t be loaded',

  // ── On the same report ──────────────────────────────────────────────────────────────────────
  sameReport: 'On the same report',
  thisOne: 'Flagged',
  hidden: 'Hidden',
  removed: 'Removed',
  thumbLabel: (n: number) => `Photo ${n} on the report, pixelated`,
  thumbAlt: (n: number) => `Photo ${n} on the report`,
  /** Coined: another photo on the report with an open flag of its own — its Inbox item. */
  itsFlag: 'Its flag',
  /** The report's list was cut short by the read: how many of how many it shows. */
  sameReportCut: (shown: number, of: string) => `Showing ${shown} of ${of} photos`,

  // ── The bar (2.7) ───────────────────────────────────────────────────────────────────────────
  what: {
    hide: 'Off its link now and shown to no one; restorable at any time',
    remove: `Deleted after ${PHOTO_PURGE_DAYS} days unless restored`,
    restore: 'Shown again where it was attached; the flags here are dismissed',
  },

  // ── The dialogs ─────────────────────────────────────────────────────────────────────────────
  hideTitle: 'Hide this photo?',
  removeTitle: 'Remove this photo?',
  /** What a takedown does to the photo: its link, and the devices that already opened it. */
  offNow:
    'It comes off its link now and is shown to no one. Anyone who already opened it may still see it on their own device for up to 30 days.',
  hideAfter: 'You can restore it at any time.',
  removeAfter: `It is deleted for good in ${PHOTO_PURGE_DAYS} days unless it is restored before then.`,
  /** What every takedown does to the flags. */
  closesFlags: 'Closes every open flag on it, in every lane, and tells each flagger.',

  // ── Receipts ────────────────────────────────────────────────────────────────────────────────
  /** What a receipt names when the photo has no body to name: the uploader's name is never used. */
  subject: 'A photo',
  /** A receipt's line after its flag count: what the write did to the photo. */
  receipt: {
    hidden: 'Off its link and shown to no one; restorable at any time',
    removed: `Off its link and shown to no one; deleted for good in ${PHOTO_PURGE_DAYS} days unless restored`,
    restored: 'Shown again where it was attached',
  },

  // ── The record sheet ────────────────────────────────────────────────────────────────────────
  record: {
    pixelated: 'The photo, pixelated',
    show: 'Show',
    noFile: 'No file to show',
  },
} as const;
