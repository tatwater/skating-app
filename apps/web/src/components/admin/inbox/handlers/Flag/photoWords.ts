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
 * **Whether a takedown moves the photo's bytes to a new address** (the dev rotation proof decides
 * it; the integrator sets this one constant). `true`: a hide or a removal stores the photo under a
 * new address and deletes the old one, so a link someone already has stops working. `false` (the
 * conservative default until the proof reports): the old address keeps serving until a removal's
 * 30-day deletion, so the dialogs say so, and a hide offers *Remove* for an urgent case.
 */
export const TAKEDOWN_MOVES_BYTES = false;

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
  /** A removed photo still inside its 30 days. */
  purgeOn: (day: string) => `Its file is deleted on ${day} unless it is restored`,

  // ── On the same report ──────────────────────────────────────────────────────────────────────
  sameReport: 'On the same report',
  thisOne: 'Flagged',
  hidden: 'Hidden',
  removed: 'Removed',
  thumbLabel: (n: number) => `Photo ${n} on the report, pixelated`,
  thumbAlt: (n: number) => `Photo ${n} on the report`,
  /** The report's list was cut short by the read: how many of how many it shows. */
  sameReportCut: (shown: number, of: string) => `Showing ${shown} of ${of} photos`,

  // ── The bar (2.7) ───────────────────────────────────────────────────────────────────────────
  what: {
    remove: `Deleted after ${PHOTO_PURGE_DAYS} days unless restored`,
    restore: 'Brings it back where it was attached and dismisses the flags here',
  },

  // ── The dialogs (their bodies are the wording's, below) ─────────────────────────────────────
  hideTitle: 'Hide this photo?',
  removeTitle: 'Remove this photo?',
  /** What every takedown does to the flags, after the wording's body. */
  closesFlags: 'Closes every open flag on it, in every lane, and tells each flagger.',
  removeInstead: 'Remove instead',

  // ── Receipts ────────────────────────────────────────────────────────────────────────────────
  /** What a receipt names when the photo has no body to name: the uploader's name is never used. */
  subject: 'A photo',

  // ── The record sheet ────────────────────────────────────────────────────────────────────────
  record: {
    pixelated: 'The photo, pixelated',
    show: 'Show',
    noFile: 'No file to show',
  },
} as const;

/**
 * **The two wordings of a takedown**, one per outcome of the rotation proof: `moved` (the bytes move
 * at takedown) and `kept` (they don't). The live console says {@link LIVE_WORDING}'s; the stories and
 * tests draw both.
 */
export const REMOVAL_WORDINGS = {
  moved: {
    hideBody:
      'Skaters stop seeing it wherever it is attached, and the photo comes off its address now. Undo brings it back and reopens the flags.',
    removeBody: `Skaters stop seeing it, and the photo comes off its address now. Its file is deleted in ${PHOTO_PURGE_DAYS} days unless it is restored.`,
    hideWhat: 'Hides it everywhere it is attached and moves it off its address',
    urgent: null,
  },
  kept: {
    hideBody:
      'Skaters stop seeing it wherever it is attached. Anyone who already has its link can still open it. Undo brings it back and reopens the flags.',
    removeBody: `Skaters stop seeing it. Anyone who already has its link can still open it until it is deleted, in ${PHOTO_PURGE_DAYS} days unless it is restored.`,
    hideWhat: 'Hides it everywhere it is attached; a link someone already has still opens it',
    urgent: `Urgent? Remove it instead: its file is deleted in ${PHOTO_PURGE_DAYS} days unless restored.`,
  },
} as const;

export type RemovalWording = keyof typeof REMOVAL_WORDINGS;

/** The wording the live console uses. */
export const LIVE_WORDING: RemovalWording = TAKEDOWN_MOVES_BYTES ? 'moved' : 'kept';
