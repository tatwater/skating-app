/**
 * **The Body console's words added by the follow-up (B01-3e)** — the save rule's results (D265), the
 * queue's refusals, the new writes' receipts, and what the Names tab says it can't show. Kept in one
 * place so the founder can read and change them together; listed in the phase doc under *wording the
 * mock did not supply* until reviewed.
 */

// ── A save's result (D265) ─────────────────────────────────────────────────────────────────────

/** A save that didn't land, said in its toast (D268): its title names the body. */
export const notSavedTitle = (subject: string | undefined): string =>
  subject === undefined ? 'Not saved' : `Not saved · ${subject}`;

/**
 * What a press-to-save control's refusal names in its toast ("Not saved · Mascoma Lake" — "The
 * ruling: …").
 */
export const PICK_WHAT = {
  name: 'The displayed name',
  cls: 'The class',
  ruling: 'The ruling',
  mean: 'The mean depth’s source',
  max: 'The max depth’s source',
  boost: 'The map boost',
  satellite: 'The satellite link',
} as const;

/** A refused save's toast: what it was, then the server's words. */
export const notSavedWhat = (what: string, said: string): string => `${what}: ${said}`;

/** Refused: the subtree's own body is not the one the write names (a missed reset). */
export const OTHER_BODY = 'Not saved: this page now shows another body. Open it again to save.';

// ── The whole-list queue gave up ──────────────────────────────────────────────────────────────

/** What a links save's refusal names in its toast ("The links: …"). */
export const LINKS_WHAT = 'The links';

/** A links change (an edit, a remove, an order) whose links another moderator changed meanwhile. */
export const LINKS_GONE =
  'Another moderator changed these links while yours was saving, so your change no longer applies to them. It wasn’t saved.';

/** In an open link editor whose link another write changed or removed: its edit can't be saved. */
export const LINK_EDITED_AWAY =
  'This link was changed or removed while you were editing it, so this edit can’t be saved. Cancel to see the list as it is now.';

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

/**
 * Standing's removal form: the operator's own words beside the fixed reason. The server writes them
 * into History and the removed lane; skaters read only the reason.
 */
export const REMOVAL_NOTE_WORDS = {
  label: 'Note · optional',
  placeholder: 'Why, in your own words',
  assist: 'Kept in History beside the reason',
} as const;

/**
 * The Body console on a narrow screen, one pane at a time: each pane's way to the other two. The
 * body is the page's front; the map and the tab are reached from it and come back to it.
 */
export const PANE_WORDS = {
  toBody: 'Back to the body',
  toMap: 'Show the map',
  toTab: 'Show the tabs',
  /** The map pane's name for a reader (the body's is *The body*, the tab's *Inspector*). */
  map: 'Map',
} as const;

// ── The summer aerial's credit, while it loads ────────────────────────────────────────────────

/**
 * What the summer aerial's credit adds after its source ("Aerial · NAIP Jun 2023 · Loading…") while
 * the photograph is on its way or some of it didn't come; nothing once it's all in. A failure here
 * is a read, not a refusal: said in place with *Try again*, never a toast. Nouns about the
 * photograph only — never a word about the ice.
 */
export const AERIAL_LOAD_WORDS = {
  loading: 'Loading…',
  failed: 'Didn’t load',
  partial: 'Part of it didn’t load',
  retry: 'Try again',
  retrying: 'Trying again…',
} as const;

// ── An ask decided meanwhile (B01-6b follow-up) ──────────────────────────────────────────────────

/**
 * A bay or landmark saved for a skater's ask that was closed while it was being drawn: decided by
 * someone else, or retracted by the skater. The shape is saved and the ask keeps how it was closed,
 * so the receipt mustn't say this save answered it, nor that anyone did.
 */
export const ASK_ALREADY_CLOSED = 'That ask was already closed, so this didn’t answer it.';
