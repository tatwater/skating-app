import { countOf } from '../../words/inboxWords';

/**
 * **Board 2.8's words** — the ticket handler's copy in one place, for the founder's copy pass. The
 * board's where it drew them (*Reply by email*, *Note*, *Note · staff only*, *Send reply*,
 * *Resolve*, *User*, *Related*, *Open in People*); the rest coined, each marked.
 *
 * Nothing here says or implies anything about the ice (D3), and none of it names a decision number,
 * a section or a phase.
 */
export const TICKET_WORDS = {
  /** The head's kicker: "Support · account". */
  title: (category: string) => `Support · ${category}`,
  openInPeople: 'Open in People',

  // ── The thread ─────────────────────────────────────────────────────────────────────────────
  /** The ticket line over the thread: "Ticket · 13 Oct 09:12 · from the app · Android 1.4.2". */
  ticketLine: 'Ticket',
  fromTheApp: 'from the app',
  fromTheWeb: 'from the web',
  thread: 'The thread',
  /** Coined: who wrote a message, once their account is gone or going (never their name). */
  formerSkater: 'A former skater',
  formerStaff: 'A former staffer',
  /** Coined: a ticket filed from a signed-in account before its profile was made. */
  noProfile: 'Someone signed in, before their profile was made',
  note: 'Note · staff only',
  reply: 'Reply by email',
  /** Coined: a note its writer took back (its Undo); its words are not kept on screen. */
  noteRemoved: 'A note was removed',
  /** Coined: the thread holds more than the read served — "Showing the newest 100 of 100+ messages". */
  shownOf: (shown: number, total: number, floor: boolean) =>
    `Showing the newest ${countOf(shown)} of ${countOf(total, floor)} ${
      total === 1 && !floor ? 'message' : 'messages'
    }`,

  // ── A reply's state ────────────────────────────────────────────────────────────────────────
  /** Coined: "Sending in 42 s". */
  sendingIn: (seconds: number) => `Sending in ${seconds} s`,
  sendingNow: 'Sending now',
  /** A settling reply's cancel (`support.cancelReply`), drawn where the server's `cancel` is null. */
  cancel: 'Cancel',
  cancelWhat: 'Cancel this reply before it is sent',
  sent: 'Sent',
  canceled: 'Canceled · never sent',
  notSent: 'Not sent',
  /** Why a reply was not sent: a class, never an address or a provider's words. Coined. */
  notSentWhy: {
    /** No support sender, or no email service key, on the deployment. */
    unconfigured: 'no sending address or email service is set up',
    seed: 'a test person’s ticket: test people are never emailed',
    noAddress: 'there is no email address for them',
    /** The provider refused it, or its send never ran. */
    sendFailed: 'the email service didn’t take it, or its send never ran',
  },
  /**
   * Coined (`outcomeUnknown`): its send started and stopped before saying how it went. Never worded as
   * sent, never as not sent — it may or may not have reached them, and it is never resent by itself.
   */
  outcomeUnknown: 'Sending stopped · it may or may not have been sent',
  notSentUnknown: 'the reason wasn’t recorded',

  // ── The dock ───────────────────────────────────────────────────────────────────────────────
  modes: 'Reply or note',
  replyMode: 'Reply by email',
  noteMode: 'Note',
  /** The dock's right end: who the reply goes to. */
  to: (name: string) => `To ${name}`,
  toThem: 'To the person who wrote in',
  /** The note's right end (coined): who reads it. */
  staffOnly: 'Staff only',
  replyLabel: 'Your reply',
  noteLabel: 'Your note',
  sendReply: 'Send reply',
  addNote: 'Add note',
  /**
   * The reply's foot: where it goes from, and that their answer by email isn't read (D284: the
   * sending domain takes no mail; every reply's footer tells them to write back from the app).
   */
  sentFrom: (address: string) => `Sent from ${address}.`,
  /** Coined: the variable is unset, so a reply would read Not sent — said before it is written. */
  noSender: 'No sending address is set up, so a reply won’t be sent: it will read Not sent.',
  /** Coined: a test person's ticket (`replyBlocked: 'seed'`) — the seed's people are never emailed. */
  seedNoSend: 'A test person’s ticket: a reply is saved here and never emailed.',
  answersNotRead: 'Their answer by email isn’t read.',
  noteFoot: 'Seen only by staff who answer support.',
  /** A form's own check (D268: in place, never a toast). */
  tooLong: (max: number, length: number, what: string) =>
    `A ${what} holds ${max.toLocaleString('en-US')} characters · this one is ${length.toLocaleString('en-US')}.`,
  replyNoun: 'reply',
  noteNoun: 'note',

  // ── The side ───────────────────────────────────────────────────────────────────────────────
  user: 'User',
  untilLabel: 'Until',
  /** "15 Oct · set by Matt" (the board's words). */
  until: (day: string, by: string) => `${day} · set by ${by}`,
  related: 'Related',
  /** Coined: a flag on Related, by its reason ("Unsafe false report flag"). */
  flagTitle: (reason: string) => `${reason} flag`,
  /** Coined: an open flag's line ("report · 4 days ago"). */
  openFlagSub: (target: string, age: string) => `${target} · ${age}`,
  /** Coined: an actioned flag's line ("Actioned 11 Oct"). */
  actionedSub: (when: string) => `Actioned ${when}`,
  inbox: 'Inbox',
  /** Coined: the server cut Related's list. */
  moreFlags: 'More flags on them',
  moreFlagsSub: 'The rest are in the Inbox',
  /** Board 2.8's *Tickets* row: "2 · 1 resolved", a floor past the server's bound. */
  tickets: 'Tickets',
  ticketsCount: (total: number, resolved: number, floor: boolean) =>
    `${countOf(total, floor)} · ${countOf(resolved, floor)} resolved`,
  nothingRelated: 'Nothing else open on them',
  resolve: 'Resolve',
  resolveWhat: 'Close the ticket: it leaves the queue, and Undo or Reopen brings it back',
  reopen: 'Reopen',
  reopenWhat: 'Put the ticket back in the queue',
  /** Coined: a resolved ticket's line in the side. */
  resolvedBy: (who: string | null, when: string) =>
    who === null ? `Resolved · ${when}` : `Resolved by ${who} · ${when}`,

  // ── Receipts and refusals (the shell's toasts) ─────────────────────────────────────────────
  bar: 'Ticket actions',
  /** The receipt's subject: whose ticket, by name — never a departed person's. */
  subject: (name: string | null) => (name === null ? 'A support ticket' : `${name}’s ticket`),
  theReply: 'The reply',
  theNote: 'The note',
  theDecision: 'The decision',
  replyQueued: 'Reply on its way',
  replyQueuedDetail: 'It sends in about a minute',
  noteAdded: 'Note added',
  noteAddedDetail: 'Seen only by staff',
  resolved: 'Resolved',
  resolvedDetail: 'It leaves the queue',
  reopened: 'Reopened',
  reopenedDetail: 'It is back in the queue',
  /** Coined: a reply written while the server says it won't be sent (`replyBlocked`). */
  replySaved: 'Reply saved, not sent',
  replyWontSend: (why: string) => `It won’t be emailed: ${why}`,
  /** Coined: a note's *Remove* (`support.removeNote`), drawn where the server's `remove` is null. */
  remove: 'Remove',
  removeWhat: 'Remove this note from the thread',
  theRemoval: 'Removing the note',
  theCancel: 'Canceling the reply',
  noteRemovedReceipt: 'Note removed',
  replyCanceled: 'Reply canceled',
  replyCanceledDetail: 'It was never sent',
} as const;
