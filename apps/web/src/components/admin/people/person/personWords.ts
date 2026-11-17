import { NOT_RECORDED, ranItsCourse, STILL_PREPARING } from '../answers';

/**
 * **Every word the person page coined** — each string the boards (8.1, 8.2, 8.5, 8.6) did not
 * supply, in one place, so the founder reads them together and the integrator can merge them with
 * the list's. Words the boards drew themselves (*Restrict*, *Account kept for appeal*, *Give it to
 * another admin first*, *Median, filed to decided*…) stay beside the code that draws them.
 *
 * Never "You", never a pronoun for a person (none is known), never a word about the ice. Ages and
 * durations here are the written-out forms (`lib/ages`); a list row's short form ("4 d") is the
 * list's, from the same module.
 */
export const WORDS = {
  // ── The three answers that are not numbers ──
  pending: STILL_PREPARING,
  notRecorded: NOT_RECORDED,
  couldNotRead: 'Couldn’t be read',
  loading: 'Loading',

  // ── Reads that failed, block by block ──
  personFailed: 'This person couldn’t be read',
  historyFailed: 'The history couldn’t be read',
  decisionsFailed: 'The decisions couldn’t be read',
  reportsFailed: 'Their reports couldn’t be read',
  staffFailed: 'Their staff figures couldn’t be read',
  noSuchPerson: 'No such person',

  // ── The status note ──
  banned: 'Banned',
  suspendedLeft: (left: string) => `Suspended · ${left}`,
  suspendedOpenEnded: 'Suspended · until lifted',
  suspendedLapsed: 'Suspended · ran its course',
  ranItsCourse,
  nameNotReady: 'Name still being prepared',
  whoAndWhenUnrecorded: 'Who and when: not recorded yet',
  /** The status began before the rows one read walks back (`statusNote.atCapped`). */
  whoAndWhenTooOld: 'Who and when: older than what one read covers',
  whenUnrecorded: 'When: not recorded yet',
  leaving: 'Leaving',
  deletedOn: (moment: string) => `The account is deleted ${moment}`,
  deleted: 'Deleted',

  // ── The strips ──
  onThePerson: (n: string) => `${n} on the person`,
  noneUndone: 'None undone by others',
  undoneByOne: (n: string) => `${n} later undone by someone else`,
  undoneByMany: (n: string) => `${n} later undone by others`,
  undonePending: 'Undone by others · still being prepared',
  medianTooMany: 'Too many decided this week to time',
  noneDecided: 'No filed items decided this week',
  tenureTooOld: 'Older than what one read covers',
  roleSince: (role: string, date: string) => `${role} since ${date}`,
  roleFromTheStart: (role: string) => `${role} from the start`,
  staffFrom: (role: string, date: string) => `${role} from ${date}`,
  reportsByMonth: 'Reports by month',
  olderMonthsUnread: 'Older months not all read',

  // ── The levers ──
  /** What each right lets a person do, for the dialogs and the toast. */
  rightVerb: {
    reports: 'post reports',
    hazards: 'mark hazards',
    comments: 'comment',
    flagging: 'flag',
  },
  restricted: 'Restricted',
  switchedOff: (filed: string) => `Switched off · ${filed}`,
  untilLifted: 'Until lifted',
  lapsed: 'Ran its course',
  bannedStatus: 'Banned · account kept for appeal',
  review: 'Review',
  onTheRecord: 'On the record',
  /** The record's Deleted and Reversed couldn't be read: the row stands, and Review still opens. */
  recordOthersFailed: 'Deleted and Reversed couldn’t be read',
  switchOn: 'Switch on',

  // ── The dialogs ──
  reasonLabel: 'Reason · kept in the audit log',
  restrictTitle: (what: string) => `Restrict ${what}?`,
  restrictBody: (name: string, verb: string) =>
    `${name} won’t be able to ${verb} until it’s restored. Everything else they can do stays as it is.`,
  flaggingOffTitle: 'Switch off flagging?',
  flaggingOffBody: (name: string) =>
    `${name}’s flags will be refused until it’s switched back on. What they already filed stays in the queue.`,
  revokeLedgerTitle: 'Revoke ledger editing?',
  stepDownTitle: 'Step down from ledger editing?',
  ledgerOffBody: (name: string) =>
    `${name} won’t be able to edit the ledger or give it to anyone. Another admin can give it back.`,
  banTitle: (name: string) => `Ban ${name}?`,
  banBody:
    'They’re signed out and can’t sign in again until the ban is lifted. The account and everything they posted are kept for an appeal.',
  roleTitle: (name: string, article: string) => `Make ${name} ${article}?`,
  demoteBody: (role: string) => `They lose what the ${role} role gives.`,
  demoteWithLedgerBody: (role: string) =>
    `They lose what the ${role} role gives, and ledger editing with it.`,
  makeAdminBody:
    'An admin can change anyone’s role and read support tickets straight away. An undo won’t reach what they do in the meantime.',
  suspendTitle: (name: string) => `Suspend ${name}?`,
  extendTitle: (name: string) => `Extend ${name}’s suspension?`,
  suspendBody:
    'They can’t use their account until it lifts on its own. Everything they posted stays up.',
  replacesBanBody: 'This replaces the ban. They can’t use their account until it lifts on its own.',
  extendBody: 'The time is added to the end already set. It still lifts on its own.',
  // ── A new window on a suspension with no end, or one that ran its course ──
  extend: 'Extend',
  setAnEnd: 'Set an end',
  setEndTitle: (name: string) => `Set an end to ${name}’s suspension?`,
  setEndBody: 'It has no end now. Choose when it lifts on its own.',
  renewTitle: (name: string) => `Suspend ${name} again from now?`,
  renewBody:
    'It ran its course. The new time runs from now, and it lifts on its own when that ends.',
  forHowLong: 'For how long',
  extendBy: 'Extend by',
  durationMore: (d: string) => `${d} more`,
  liftsAt: (moment: string) => `Lifts ${moment}`,
  bountyTitle: (name: string) => `Set ${name}’s bounty limit?`,
  bountyBody:
    'How many open bounties they can post in a day. Zero stops bounties and leaves everything else as it is.',
  bountyDefault: (n: number) => `The default · ${n} a day`,
  bountyOwn: 'A limit of their own',
  bountyField: 'Open bounties',
  perDay: 'per day',

  // ── The feeds ──
  moreBefore: 'More happened before these',
  noDecisions: 'No decisions on record',
  decisionsShown: (n: string) => `${n} shown · more happened before these`,
  showMore: 'Show more',
  flagsPending: 'Flags on their content are still being prepared',
  recordUncounted: 'More than one read covers',
  openCapped: 'More may be open than one read covers',
  verdictsPending: 'Decisions on flags about their content are still being prepared',
  accountCreated: 'Account created',
  system: 'System',
  anUndo: 'an undo',
  appealWaiting: 'waiting',
  undone: 'Undone',
  changedSince: 'Changed since',

  // ── A History or Decisions row about a person (`who` is their name, or "an account") ──
  anAccount: 'an account',
  suspendedUntil: (who: string, date: string) => `Suspended ${who} until ${date}`,
  suspendedWho: (who: string) => `Suspended ${who}`,
  bannedWho: (who: string) => `Banned ${who}`,
  liftedBan: (who: string) => `Lifted the ban on ${who}`,
  liftedSuspension: (who: string) => `Lifted the suspension on ${who}`,
  liftedEither: (who: string) => `Lifted a ban or suspension on ${who}`,
  bountyDefaultFor: (who: string) => `Put the bounty limit for ${who} back to the default`,
  bountySetFor: (who: string, n: number) => `Set the bounty limit for ${who} to ${n}`,
  flaggingOnFor: (who: string) => `Switched flagging back on for ${who}`,
  flaggingOffFor: (who: string) => `Switched off flagging for ${who}`,
  restoredFor: (what: string, who: string) => `Restored ${what} for ${who}`,
  restrictedFor: (what: string, who: string) => `Restricted ${what} for ${who}`,
  rightsChangedFor: (who: string) => `Changed posting rights for ${who}`,
  madeRole: (who: string, article: string) => `Made ${who} ${article}`,
  gaveLedger: (who: string) => `Gave ${who} ledger editing`,
  tookLedger: (who: string) => `Took ledger editing from ${who}`,

  // ── What an open flag is on ──
  flagOn: {
    report: 'a report',
    comment: 'a comment',
    photo: 'a photo',
    user: 'the person',
    hazard: 'a hazard',
    accessAlert: 'an access alert',
    waterbody: 'a body',
    post: 'a post',
  } as Record<string, string>,
  flagOnUnknown: 'their content',

  // ── The trend plates ──
  kept: 'Kept',
  hidden: 'Hidden',
  decisions: 'Decisions',

  // ── The receipts (the toast's words) ──
  canAgain: (name: string, verb: string) => `${name} can ${verb} again`,
  cannot: (name: string, verb: string) => `${name} can’t ${verb}`,
  restOfRights: 'Everything else they can do stays as it is',
  bountyBack: (name: string, n: number) => `${name}’s bounty limit is back to the default (${n})`,
  bountyIs: (name: string, n: number) => `${name}’s bounty limit is ${n}`,
  suspended: (name: string) => `${name} is suspended`,
  extended: (name: string) => `${name}’s suspension is extended`,
  endSet: (name: string) => `${name}’s suspension now has an end`,
  suspendedAgain: (name: string) => `${name} is suspended again`,
  liftsOnItsOwnReceipt: (moment: string) => `It lifts on its own ${moment}`,
  canSignIn: (name: string) => `${name} can sign in again`,
  /** A write that would have left them exactly as they were: the server wrote nothing. */
  alreadySo: (name: string) => `Nothing changed — ${name} was already set that way`,
  isBanned: (name: string) => `${name} is banned`,
  keptForAppeal: 'The account is kept for an appeal',
  isNow: (name: string, article: string) => `${name} is now ${article}`,
  ledgerPassOn: 'They can give it to other admins too',
  cannotEditLedger: (name: string) => `${name} can’t edit the ledger`,

  // ── The write path ──
  anotherOnItsWay: 'Another change is still on its way',
} as const;
