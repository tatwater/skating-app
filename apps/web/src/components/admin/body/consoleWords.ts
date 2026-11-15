/**
 * **The Body console's words added by the follow-up (B01-3e)** — the save rule's results (D265), the
 * queue's refusals, the new writes' receipts, and what the Names tab says it can't show. Kept in one
 * place so the founder can read and change them together; listed in the phase doc under *wording the
 * mock did not supply* until reviewed.
 */

// ── A save's result (D265) ─────────────────────────────────────────────────────────────────────

/** A save that didn't land, said off its console: its title names the body. */
export const notSavedTitle = (subject: string | undefined): string =>
  subject === undefined ? 'Not saved' : `Not saved · ${subject}`;

/** A save off its console's toast: what it was, then the server's words. */
export const notSavedWhat = (what: string, said: string): string => `${what}: ${said}`;

/** Refused: the subtree's own body is not the one the write names (a missed reset). */
export const OTHER_BODY = 'Not saved: this page now shows another body. Open it again to save.';

// ── The whole-list queue gave up ──────────────────────────────────────────────────────────────

/** A links change whose link another moderator changed or removed meanwhile. */
export const LINKS_GONE =
  'Another moderator changed these links while yours was saving, and the link you changed is gone. Your change wasn’t saved.';

/** A links change the list kept moving under, past the queue's re-applications. */
export const LINKS_KEPT_MOVING =
  'Another moderator kept changing these links while yours was saving. Your change wasn’t saved — try again.';

/** The aliases' change gave up: another moderator kept changing the list under it. */
export const ALIASES_KEPT_MOVING =
  'Another moderator kept changing these aliases while yours was saving. Your change wasn’t saved — try again.';

/** A landmark's spellings kept changing under the queue. */
export const SPELLINGS_KEPT_MOVING =
  'Another moderator kept changing these spellings; yours weren’t saved. Try again.';

// ── The new writes' receipts ──────────────────────────────────────────────────────────────────

export const RECEIPTS = {
  aliasesSaved: 'Aliases saved',
  classSet: (label: string) => `Class set to ${label}`,
  classCleared: 'Back to the catalogs’ class',
  depthFrom: (measure: 'mean' | 'max', source: string) =>
    `${measure === 'mean' ? 'Mean' : 'Max'} depth from ${source}`,
} as const;

// ── Names: what isn't recorded or drawn ───────────────────────────────────────────────────────

/** Each catalog's class: stored by the import from now, so an older body has none until then. */
export const CLASS_CLAIMS_NOT_RECORDED =
  'Each catalog’s class: not recorded until this body’s next import campaign';

/** The tab's failures, as "Couldn't read …" names each read. */
export const NAMES_READ_PARTS = {
  identity: 'the moderator’s aliases and class',
  townLines: 'the town lines',
} as const;

/** "On the map, 1 town's line isn't stored yet": what the map's town lines leave out. */
export function townLinesShortWords(
  short: { unstored: number; capped: boolean } | undefined,
): string | null {
  if (short === undefined) return null;
  const parts = [
    short.unstored > 0 &&
      `${short.unstored} ${short.unstored === 1 ? 'town’s line isn’t' : 'towns’ lines aren’t'} stored yet`,
    short.capped && 'more towns than one read returns: some lines aren’t drawn',
  ].filter((p): p is string => p !== false);
  return parts.length === 0 ? null : `On the map, ${parts.join('; ')}`;
}

// ── A body that left ──────────────────────────────────────────────────────────────────────────

/** A removed body whose record names no row for its leaving. */
export const LEFT_NOT_SAID = 'The record doesn’t say when it left';
