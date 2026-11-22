/**
 * **Every word the flag handler, its blocks and *Around it* say** — one module for the founder's copy
 * pass. The boards (2.1, its drawer, 2.6) supplied most of them; the rest were written for the
 * handlers no board draws and are listed as such in the builder's report. Nothing here may say or
 * imply that ice is safe, skateable or "good to go", or that a report is right or wrong (D3, D288):
 * the weather and the Stefan figure are context beside a claim, never a verdict on it.
 *
 * No decision numbers, section marks or phase tokens; "bodies", never "lakes"; access is
 * *accessible*, never *open*.
 */

import type { AroundItPhraseKey } from '@skating/core';

/** A flag's reason as a pane head names it (board 2.1's "Unsafe false report"). */
export const REASON_HEAD = {
  unsafe_false_report: 'Unsafe false report',
  spam: 'Spam',
  harassment: 'Harassment',
  inappropriate: 'Inappropriate',
  auto_low_quality: 'Rated unhelpful',
  no_public_access: 'No public access',
  other: 'Other',
} as const;

/** What was flagged, as a pane head and a group label name it. */
export const TARGET_WORDS = {
  report: 'Report',
  post: 'Post',
  comment: 'Comment',
  hazard: 'Hazard',
  photo: 'Photo',
  accessAlert: 'Alert',
  waterbody: 'Body',
  user: 'Person',
} as const;

export const FLAG_WORDS = {
  // ── The pane head ───────────────────────────────────────────────────────────────────────────
  /** "Flag on an access alert" (2.6), "Flag on a comment" — a content flag's head. */
  flagOn: (what: string) => `Flag on ${what}`,
  /** The Safety lane's head: whose claim it is — the flaggers' reason, not the console's finding. */
  flaggedAs: 'Flagged as unsafe',
  flagOnWhat: {
    report: 'a report',
    post: 'a Post',
    comment: 'a comment',
    hazard: 'a hazard',
    photo: 'a photo',
    accessAlert: 'an access alert',
    waterbody: 'a body',
    user: 'a person',
  },
  safetyBadge: 'Safety',
  openInReports: 'Open in Reports',
  openInPeople: 'Open in People',
  openInBody: 'Open in Body',
  history: 'History',

  // ── The subject ─────────────────────────────────────────────────────────────────────────────
  reportKicker: 'Report',
  postKicker: 'Post',
  commentKicker: 'Comment',
  hazardKicker: 'Hazard',
  alertKicker: 'Access alert',
  personKicker: 'Person',
  bodyKicker: 'Body',
  commentOn: 'On',
  postReports: (n: number) => (n === 1 ? '1 report in this Post' : `${n} reports in this Post`),
  untitledPost: 'Untitled Post',
  noNotes: 'No notes on this report',
  wordsHidden: 'Its words are shown only to staff who can read hidden content',
  withdrawn: (day: string) => `Withdrawn on ${day}`,
  /** Which withdrawal it was (the view's `withdrawal`): the author's delete, or the 30-day erasure. */
  withdrawnSub: {
    deleted: 'Its author deleted it. Skaters no longer see it, and nothing here brings it back.',
    erased:
      'It was erased: its author deleted it and its words are gone. Skaters no longer see it, and nothing here brings it back.',
  },
  retracted: (day: string) => `Retracted on ${day}`,
  retractedSub: 'Its author took it down. Skaters no longer see it.',
  withdrawnTakeDownBody:
    'Its author withdrew it, so skaters won’t see it again either way: this keeps the decision on their record, and closes every open flag on it, in every lane, telling each flagger.',
  reportPoint: 'Report point',
  gone: 'This content is gone',
  goneSub: 'Its author deleted it, or it was erased. The flags on it are still open.',
  down: {
    hidden: 'Hidden before this flag was read',
    removed: 'Removed before this flag was read',
  },
  downSub: 'Restoring it brings it back and dismisses the flags here.',
  hazardVotesTitle: 'Votes, as skaters cast them',
  hazardVotesNone: 'No one has voted on it yet',
  /** What the counts count, so they and the flag's own count tell one story. */
  hazardVotesWhat: 'Every vote cast, a changed vote and the reporter’s own included',
  hazardFootprintMissing: 'No point recorded for this hazard',

  // ── That night, at the body (2.1) ───────────────────────────────────────────────────────────
  thatNight: 'That night, at the body',
  low: (day: string) => `Low · ${day}`,
  freezingNights: 'Freezing nights',
  inARow: 'in a row',
  thenAGap: 'in a row, then a gap',
  degreeDays: 'Freezing degree-days',
  sinceOct1: 'since 1 Oct',
  /** The degree-days' unit: imperial (D25), as °F below freezing summed by day. */
  degreeDaysUnit: '°F·days since 1 Oct',
  degreeDaysUnitShort: '°F·days',
  /** A season with days not recorded: the figure covers only those that were. */
  degreeDaysPartial: (n: number, of: number) =>
    `From ${n} of the ${of} days since 1 Oct; the rest weren’t recorded`,
  stefan: 'Stefan thickness estimate',
  stefanSub: "A model's figure from air temperatures only — context, not a verdict",
  stefanHow: 'How it is calculated',
  stefanDeclined: {
    thaw: 'Too much thaw in the last 60 days for the estimate',
    too_little_cold: 'Not enough cold yet for an estimate',
    no_weather: 'No weather recorded for this body',
  },
  notRecorded: 'Not recorded',
  weatherMissing: 'Not recorded yet',
  weatherMissingSub:
    'No weather is kept for this body, so there is nothing to set beside the claim.',
  weatherLoading: 'Reading the weather',
  weatherFailed: 'The weather for that night couldn’t be read',
  weatherContext: 'The weather is context, not a verdict.',
  approx: '~',
  inches: 'in',
  degF: '°F',

  // ── Also on this report ─────────────────────────────────────────────────────────────────────
  alsoOn: 'Also on this report',
  thumbs: 'Thumbs',
  corrob: 'Corrob.',
  corroborated: (n: string, one: boolean) => `${n} other ${one ? 'report' : 'reports'} agreed`,
  thumbsLine: (up: number, down: number) => ({ up: `${up} up`, down: `${down} down` }),

  // ── The flag block ──────────────────────────────────────────────────────────────────────────
  flag: 'Flag',
  flags: 'Flags',
  filedByApp: 'Filed by the app',
  /** What filed an app's flag, by its reason and its target. */
  appRule: {
    /** The vote rule, in the verdict's own words for this hazard's type ("Nothing here — never was"). */
    hazardNeverExisted: (people: number, verdict: string) =>
      `The app files this when ${people} people vote “${verdict}”`,
    /** What the rule counted, never what it concluded: the weather records aren't a judge. */
    contradiction: (counted: string | null) =>
      counted === null
        ? 'The contradiction check filed this: some of their recent reports differed from the weather records'
        : `The contradiction check filed this: ${counted} of their recent reports differed from the weather records`,
    lowQuality: 'Enough people rated it unhelpful',
    other: 'A rule in the app filed it',
  },
  occurrence: (ordinal: string) => `${ordinal} occurrence`,
  lastResolved: (verdict: string, age: string) => `last ${verdict} ${age} ago`,
  priorVerdict: { dismissed: 'dismissed', actioned: 'actioned' } as Record<string, string>,
  noNote: 'No words given',
  goneFiler: 'Someone who has left',

  // ── The author block ────────────────────────────────────────────────────────────────────────
  author: 'Author',
  thePerson: 'The person',
  user: 'User',
  status: 'Status',
  reports: 'Reports',
  trust: 'Trust',
  openFlags: 'Open flags',
  canPost: 'Can post',
  /** A count of the reports the check flagged, not a verdict on them. */
  contradicted: (n: string) => `${n} flagged by the contradiction check`,
  priorActioned: (n: string, one: boolean, day: string | null) =>
    one
      ? `An earlier flag on them was actioned${day === null ? '' : ` on ${day}`}`
      : `${n} earlier flags on them were actioned${day === null ? '' : `, the latest on ${day}`}`,
  contradictedReports: 'Reports the rule counted',
  openInApp: 'Open in the app',
  thisOne: 'this one',
  standing: {
    active: 'Active',
    suspended: 'Suspended',
    banned: 'Banned',
    leaving: 'Leaving',
    deleted: 'Deleted',
  },
  until: (date: string) => `until ${date}`,
  by: (name: string) => `by ${name}`,
  postsNothing: 'Nothing',
  unknownCount: 'Not recorded yet',
  staff: 'Staff',
  departed: 'Someone who has left',

  // ── The author menu ─────────────────────────────────────────────────────────────────────────
  authorMenu: (name: string) => `${name}: what they can do`,
  noLevers: 'Nothing you can change here',
  leversLoading: 'Reading what you can change',

  // ── The action bar ──────────────────────────────────────────────────────────────────────────
  bar: 'Flag actions',
  groupFlag: 'Flag',
  groupAuthor: 'Author',
  dismiss: 'Dismiss',
  hide: 'Hide',
  remove: 'Remove',
  restore: 'Restore',
  pin: 'Pin',
  unpin: 'Unpin',
  retract: 'Retract',
  what: {
    dismiss: 'Clears the flags on this item and tells each flagger; the content stays as it is',
    hide: 'Hides it from skaters and closes every open flag on it, in every lane',
    remove: 'Removes it and closes every open flag on it, in every lane',
    restore: 'Brings it back and dismisses the flags here',
    pin: 'Pins it as official: it stops lapsing, and every open flag on it is dismissed',
    unpin: 'Back to active; it lapses on its own',
    retract: 'Takes the alert down as no longer true; its author is told',
  },

  // ── The dialogs ─────────────────────────────────────────────────────────────────────────────
  dismissTitle: 'Dismiss the flags here?',
  dismissBody: (n: number) =>
    n === 1
      ? 'Clears this flag only; the flagger is told. Flags on this content in other lanes stay open.'
      : `Clears these ${n} flags only; each flagger is told. Flags on this content in other lanes stay open.`,
  hideTitle: (what: string) => `Hide this ${what}?`,
  removeTitle: (what: string) => `Remove this ${what}?`,
  takeDownBody:
    'Closes every open flag on it, in every lane, and tells each flagger. Undo brings it back and reopens them.',
  pinTitle: 'Pin this alert as official?',
  pinBody:
    'It stops lapsing and carries your name. This decides it: every open flag on it, in every lane, is dismissed, and each flagger is told once.',
  unpinTitle: 'Unpin this alert?',
  unpinBody: 'It goes back to active and lapses on its own. Every open flag on it closes.',
  retractTitle: 'Retract this alert?',
  retractBody:
    'Skaters stop seeing it and its author is told. Every open flag on it closes, each flagger told.',
  restoreTitle: (what: string) => `Restore this ${what}?`,
  restoreBody: 'Skaters see it again, and the flags here are dismissed.',
  reasonOptional: 'Reason · optional',
  reasonLabel: 'Reason',

  // ── Receipts and refusals ───────────────────────────────────────────────────────────────────
  notChanged: (subject: string) => (subject === '' ? 'Not changed' : `Not changed · ${subject}`),
  receipt: {
    dismissed: 'Dismissed',
    hidden: 'Hidden',
    removed: 'Removed',
    pinned: 'Pinned',
    unpinned: 'Unpinned',
    retracted: 'Retracted',
    restored: 'Restored',
  },
  /**
   * What a decision does to the flags it covers — said as what it does, not as done: a large one
   * closes its later flags moments after the toast (`flagsClosed` counts every flag it covers). A
   * takedown or an alert's verdict covers every open flag on the content, every lane's.
   */
  closesAcross: (n: number, elsewhere: number) =>
    `Closes ${n === 1 ? '1 flag' : `${n} flags`}${elsewhere > 0 ? `, ${elsewhere} in other lanes` : ''}`,
  /** A dismissal, a restore and a pin side with the content: its flags are dismissed. */
  dismissesAcross: (n: number, elsewhere: number) =>
    `Dismisses ${n === 1 ? '1 flag' : `${n} flags`}${elsewhere > 0 ? `, ${elsewhere} in other lanes` : ''}`,
} as const;

/** *Around it* — the line under the claim and its drawer (2.1, `?around=1`). */
export const AROUND_WORDS = {
  title: 'Around it',
  compare: 'Compare',
  /** The line: "3 more reports at Mascoma Lake, within 3 days of this one". */
  /** `capped`: the read stopped short on a side, so the count is a floor ("100+ more reports"). */
  line: (n: number, body: string, days: number, capped = false) =>
    `${n === 1 && !capped ? '1 more report' : `${n}${capped ? '+' : ''} more reports`} at ${body}, within ${days === 1 ? '1 day' : `${days} days`} of this one`,
  lineNone: (body: string, days: number) =>
    `No other reports at ${body} within ${days === 1 ? '1 day' : `${days} days`} of this one`,
  loading: 'Reading the reports around it',
  missing: 'The reports around it couldn’t be read',
  gone: 'This report is gone, so there is nothing around it to read',
  /** Each phrase, from the reports' own claims — never a class they didn't choose (D3). */
  phrase: {
    measured_less: (n: number) => `${n} measured less`,
    measured_more: (n: number) => `${n} measured more`,
    open_water: (n: number) => `${n} saw open water`,
    skim_ice: (n: number) => `${n} saw skim ice`,
    dont_go: (n: number) => `${n} said don't go`,
    wet_or_slushy: (n: number) => `${n} surface wet or slushy`,
  } satisfies Record<AroundItPhraseKey, (n: number) => string>,

  // ── The drawer ──────────────────────────────────────────────────────────────────────────────
  sheetTitle: 'Reports around this one',
  window: (days: number) => `±${days} ${days === 1 ? 'day' : 'days'}`,
  windowLabel: 'How far either side',
  close: 'Close',
  statReports: 'Reports',
  inclThis: 'incl. this one',
  onIce: 'On the ice',
  fromShore: 'From shore',
  secondhand: 'Secondhand',
  measured: 'Measured',
  measuredNone: 'None',
  thisReport: 'This report',
  noReports: 'no reports',
  authorReports: (n: number) => (n === 1 ? '1 report' : `${n} reports`),
  staff: 'staff',
  hidden: 'Hidden',
  removed: 'Removed',
  openInReports: 'Open in Reports',
  openAll: (n: string) => `Open all ${n} in Reports`,
  foot: 'Every report at this body in the timeframe.',
  cappedBefore:
    'More reports lie before this window than one read holds; the earliest are not listed.',
  cappedAfter: 'More reports lie after this window than one read holds; the latest are not listed.',
  departed: 'Someone who has left',
  sheetMissing: 'This report is gone, so there is nothing around it to read.',
} as const;

/** An access alert's subject and its life (2.6). */
export const ALERT_WORDS = {
  asSkatersSee: 'As skaters see it',
  theFlag: 'The flag',
  life: "The alert's life",
  theAlert: 'The alert',
  whatEachDoes: 'What each does',
  author: 'Author',
  reason: 'Reason',
  votes: 'Votes',
  votesLine: (up: number, down: number) => `${up} still so · ${down} not so`,
  official: 'Official',
  event: {
    posted: 'Posted',
    pinned: 'Pinned official',
    unpinned: 'Unpinned',
    confirmed: 'Still so',
    denied: 'Not so',
    flagged: 'Flagged',
    retracted: 'Retracted',
    resolved: 'Resolved',
  },
  confirmedTimes: (n: number) => `Still so ×${n}`,
  today: (day: string) => `${day} · today`,
  todayTitle: 'Today',
  wouldLapse: 'Would lapse',
  ifNoOneActs: 'If no one acts',
  lineActive: 'Active · lapses on its own',
  linePinned: 'Pinned official',
  lineNext: 'If no one acts',
  pinnedSince: (day: string) => `Pinned · since ${day}`,
  lapses: (day: string) => `Active · lapses ${day}`,
  status: {
    active: 'Active',
    official: 'Pinned',
    expired: 'Lapsed',
    retracted: 'Retracted',
    resolved: 'Resolved',
  } as Record<string, string>,
  does: {
    pin: 'Official · stops lapsing · the flags dismissed',
    unpin: 'Back to active · lapses on its own',
    retract: 'Gone · no longer true · author told',
    dismiss: (who: string) =>
      who === '' ? 'The flag only · the flagger told' : `The flag only · ${who} told`,
  },
} as const;
