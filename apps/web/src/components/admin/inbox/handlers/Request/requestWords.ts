import type { RequestKind } from '@skating/core';

import { REQUEST_WORDS } from '../../../bodies/askWords';

/**
 * **Every word the request handler draws**, in one place for the founder's copy pass. The request
 * kinds' names are the Bodies preview's founder-approved ones (`bodies/askWords.ts`, read through
 * {@link kindName}), so a kind is never worded twice.
 *
 * **From the board** (2.3, `inbox-handler-v5.html?h=admit`): *Admit a body*, *Asked by 2 · 3 days
 * ago*, *The ask*, *2 people*, *The catalog* and its rows (*Source*, *Class*, *Area*, *Name*, *None in
 * any catalog*, *Matched*, *‹age› · ‹distance› from the ask*, *Nearest*), *Admitting it* (*Adds* · *The
 * outline as an active body*, *Closes* · *2 asks · both told*, *Then* · *Enrichment queues it*),
 * *Declining it* (*Adds* · *Nothing*, *Closes* · *2 asks · told, with your note*), *Admit* (A),
 * *Decline* (D).
 *
 * **Invented** — everything else: the other kinds' heads, blocks and buttons (derived from 2.3 as
 * the design's table says), the no-match catalog block, the dialogs, the receipts, the notes. None
 * says anything about the ice (D3): a request is about which water the map holds.
 */
export const REQUEST_HANDLER_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────
  theAsk: 'The ask',
  theCatalog: 'The catalog',
  source: 'Source',
  class: 'Class',
  area: 'Area',
  name: 'Name',
  noName: 'None in any catalog',
  matched: 'Matched',
  nearest: 'Nearest',
  adds: 'Adds',
  closes: 'Closes',
  thenRow: 'Then',
  nothing: 'Nothing',
  outlineActive: 'The outline as an active body',
  enrichmentQueues: 'Enrichment queues it',
  admit: 'Admit',
  decline: 'Decline',
  bar: 'Request',

  // ── Invented ────────────────────────────────────────────────────────────────────────────────
  /**
   * The pane head's kicker for an admit (the board's). Every other kind's head is its founder-approved
   * name ({@link kindName}: *Activation*, *Restoration*, *Access contested*, *Takedown*).
   */
  admitHead: 'Admit a body',
  /** The *Then* rows' future: what each lever does, by kind (2.3's *Admitting it* is the board's). */
  ifApproved: {
    admit: 'Admitting it',
    activate: 'Activating it',
    restore: 'Restoring it',
    contest_access: 'Confirming it accessible',
    takedown: 'Taking it down',
    name_bay: 'Approving it',
    name_landmark: 'Approving it',
  } satisfies Record<RequestKind, string>,
  ifDeclined: 'Declining it',
  ifLookedUp: 'Looking it up again',
  /** The approving button, by kind (2.3's *Admit* is the board's). */
  approve: {
    admit: 'Admit',
    activate: 'Activate',
    restore: 'Restore',
    contest_access: 'Confirm accessible',
    takedown: 'Take it down',
    name_bay: 'Approve',
    name_landmark: 'Approve',
  } satisfies Record<RequestKind, string>,
  lookUpAgain: 'Look up again',
  /** Each button's tooltip (the bar has no explaining line). */
  what: {
    admit: 'Adds the catalog’s outline as an active body and closes every ask for it.',
    activate: 'Brings the body back to the active map and closes every ask for it.',
    restore: 'Reverses the removal and closes every ask for it.',
    contest_access: 'Rules the body accessible and closes every ask for it.',
    takedown: 'Removes the body at its owner’s request. Asks a reason the asker reads.',
    name_bay: 'Records that the bay drawn answers the ask.',
    name_landmark: 'Records that the landmark answers the ask.',
  } satisfies Record<RequestKind, string>,
  whatDecline: 'Closes every ask for it, each asker told with your note. Asks the note.',
  whatLookUp: 'Asks the catalog again at the ask’s point.',

  /** The body's block, for a request on a body we hold. */
  theBody: 'The body',
  place: 'Place',
  standing: 'Standing',
  removed: 'Removed',
  /** The no-match catalog block. */
  lookup: 'Lookup',
  notAnsweredYet: 'Not answered yet',
  /** The *If* rows for the kinds the board doesn't draw. */
  bringsBack: 'Returns',
  sets: 'Sets',
  takesOff: 'Takes off',
  leaves: 'Leaves',
  asks: 'Asks',
  activeMap: 'The body, on the active map',
  enrichmentIfMissing: 'Enrichment queues it if it has none',
  restoredUnlessRuled: 'The body, unless a no-access ruling stands',
  rulingAccessible: 'The ruling, to accessible',
  searchAndPush: 'Search and every push',
  zoomedIn: 'The body on the map zoomed in, with the reason',
  catalogAgain: 'The catalog, at the ask’s point',
  admitOnceMatched: 'Admit, once it matches',
  /** "Closes 2 asks · both told" (the board's), for any count — a floor past the server's. */
  closesTold: (n: number, floor: boolean) =>
    floor
      ? `${n.toLocaleString('en-US')}+ asks · all told`
      : n === 1
        ? '1 ask · told'
        : n === 2
          ? '2 asks · both told'
          : `${n.toLocaleString('en-US')} asks · all told`,
  closesWithNote: (n: number, floor: boolean) =>
    `${n === 1 && !floor ? '1 ask' : `${n.toLocaleString('en-US')}${floor ? '+' : ''} asks`} · told, with your note`,
  /** The ask section's count at its end (*2 people*). */
  people: (n: number, floor: boolean) =>
    `${n.toLocaleString('en-US')}${floor ? '+' : ''} ${n === 1 && !floor ? 'person' : 'people'}`,
  /** A matched catalog feature's age and its distance from the ask (*3 d ago · 38 m from the ask*). */
  matchedWhen: (age: string, distance: string | null) =>
    distance === null ? `${age} ago` : `${age} ago · ${distance} from the ask`,
  /** A source and its feature's id (*3DHP · YQ4K2*). */
  sourceId: (id: string) => `3DHP · ${id}`,
  /** A body with no name the catalog knows, as a receipt names it. */
  unnamedWater: 'Unnamed water',

  /** Why the levers aren't drawn: restore and takedown are an admin's (D48). */
  adminDecides: 'An admin decides this',

  /** The dialogs. */
  declineTitle: (subject: string) => `Decline · ${subject}`,
  declineBody:
    'Every ask for it closes, and each asker reads your note. Declining keeps the record.',
  noteLabel: 'Note · the asker reads it',
  takedownTitle: (subject: string) => `Take it down · ${subject}`,
  takedownBody:
    'The body leaves search and every push; it stays on the map zoomed in, marked removed. Every ask for it closes, and each asker reads your reason.',
  reasonLabel: 'Reason · the asker reads it',

  /** The receipts: what landed, then what it closes (present tense). */
  receipt: {
    admit: 'Admitted',
    activate: 'Activated',
    restore: 'Restored',
    contest_access: 'Ruled accessible',
    takedown: 'Taken down',
    name_bay: 'Approved',
    name_landmark: 'Approved',
  } satisfies Record<RequestKind, string>,
  declined: 'Declined',
  lookingUp: 'Looking it up again',
  lookingUpDetail: 'The catalog answers in a moment',
  closesReceipt: (n: number, floor: boolean) =>
    `Closes ${floor ? `${n.toLocaleString('en-US')}+ asks` : n === 1 ? '1 ask' : `${n.toLocaleString('en-US')} asks`} · each asker told`,
  /** What a refusal's toast says was not saved ("Not saved · ‹item›" — "The decision: …"). */
  theDecision: 'The decision',
  theLookup: 'The lookup',

  openInBody: 'Open in Body',
} as const;

/** A request kind's founder-approved name ("Admission", "Takedown"). */
export const kindName = (kind: RequestKind): string => REQUEST_WORDS[kind];
