import { shortAge } from '@/lib/ages';

import { floorText, NOT_RECORDED, STILL_PREPARING } from '../answers';

/**
 * **Every word the record sheet says that the boards didn't supply** (8.7–8.9) — in one place, so
 * the founder reads them together. Words the boards drew (*On the record*, *Standing*, *Deleted*,
 * *Reversed*, *Restore*, *Hide again*, *Overturn*, *Keep on the record*, *Its life*, *If overturned*,
 * *If kept*, *Restore the post*, *Its reports*, *Still being prepared · decisions made before the
 * record began are being added*, *Nothing on the record*, *The record couldn’t be read*, *The words
 * were erased*, *Can’t undo*, *The record*…) are here too, so a word is never spelled twice.
 *
 * A refusal is never worded here: the server's sentence (`can.why`, a write's error) is shown as
 * written. Never a pronoun for a person (none is known), never a word about the ice: a decision
 * on a hazard says what was decided about the post, never that the ice is safe or the hazard ended.
 */

/** The five kinds a decision lands on, as the server names them. */
export type RecordKind = 'report' | 'post' | 'comment' | 'hazard' | 'accessAlert';

/** Each kind's word, its plural, and its capitalized form (a pane's kicker). */
export const KIND_WORDS: Readonly<Record<RecordKind, { one: string; many: string; head: string }>> =
  {
    report: { one: 'report', many: 'reports', head: 'Report' },
    post: { one: 'post', many: 'posts', head: 'Post' },
    comment: { one: 'comment', many: 'comments', head: 'Comment' },
    hazard: { one: 'hazard', many: 'hazards', head: 'Hazard' },
    accessAlert: { one: 'access alert', many: 'access alerts', head: 'Access alert' },
  };

/** The kinds in the order every list of them is written. */
export const KIND_ORDER: readonly RecordKind[] = [
  'report',
  'post',
  'comment',
  'hazard',
  'accessAlert',
];

/** "1 report", "3 reports", "412+ reports" — a floor's plural is always the many form. */
export function kindCount(kind: RecordKind, count: number, capped: boolean): string {
  const w = KIND_WORDS[kind];
  return `${floorText({ count, capped })} ${count === 1 && !capped ? w.one : w.many}`;
}

export const RECORD_WORDS = {
  // ── The sheet ──
  title: 'On the record',
  close: 'Close',
  back: 'The record',
  pending: STILL_PREPARING,
  notRecorded: NOT_RECORDED,
  /** The head's count: what stands on the record ("6 items", "500+ items", "0 items"). */
  items: (count: number, capped: boolean) =>
    `${floorText({ count, capped })} ${count === 1 && !capped ? 'item' : 'items'}`,
  personFailed: 'Who this is couldn’t be read',

  // ── The tabs and the filter ──
  tabs: { standing: 'Standing', deleted: 'Deleted', reversed: 'Reversed' } as const,
  tabsLabel: 'Which list',
  filter: 'Filter',
  kindFacet: 'Kind',

  // ── A list's three answers, and its end ──
  preparingNote: 'Still being prepared · decisions made before the record began are being added',
  listFailed: 'The record couldn’t be read',
  /** Its end tab, once every page is in. */
  all: (n: number) => `All ${n.toLocaleString('en-US')}`,
  allWithRestored: (n: number, restored: number) =>
    `All ${n.toLocaleString('en-US')} · ${restored.toLocaleString('en-US')} restored`,
  /** Its end tab while the record is still being prepared: never "all". */
  soFar: (n: number) => (n === 0 ? 'Nothing so far' : `${n.toLocaleString('en-US')} so far`),
  /** An empty list's end tab, by list. */
  empty: {
    standing: 'Nothing on the record',
    deleted: 'Nothing they deleted is waiting',
    reversed: 'Nothing reversed',
  } as const,
  /** An empty list narrowed to one kind. */
  emptyOfKind: (kind: RecordKind) => `No ${KIND_WORDS[kind].many} here`,
  listLabel: (tab: string) => `${tab} items`,

  // ── A row ──
  /**
   * A row's age at its right: the console's short form ("4 d", "209 d"). The boards draw months
   * past a few weeks ("7 mo"); that is the founder's call, and this is the one place it changes.
   */
  rowAge: (ms: number) => shortAge(ms),
  /** A decision's word, as its chip and its place line say it. */
  verdict: { hidden: 'hidden', removed: 'removed', retracted: 'retracted' } as const,
  /** The author's own withdrawal: a deletion, an alert's retraction. */
  deletedChip: 'deleted',
  retractedChip: 'retracted',
  keptChip: 'kept',
  erasedChip: 'erased',
  ended: { restore: 'restored', undo: 'undone', overturn: 'overturned' } as const,
  reason: 'Reason',
  reasonUnrecorded: 'Reason: not recorded yet',
  /** Words that are gone, or were never written. */
  wordsErased: 'The words were erased',
  noWords: 'Nothing written',
  onReportOf: (who: string) => `On ${who}’s report`,
  onAReport: 'On a report',
  reportsInPost: (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'report' : 'reports'}`,
  deletedThen: (date: string) => `Deleted ${date}`,
  retractedThen: (date: string) => `Retracted ${date}`,
  erasedOn: (date: string) => `erased ${date} unless kept`,
  eraseUnrecorded: 'when it’s erased: not recorded yet',
  erasedLine: (date: string) => `Erased ${date}`,
  endedBy: { restore: 'restored it', undo: 'undid it', overturn: 'overturned it' } as const,
  whoEndedUnrecorded: 'Who ended it: not recorded yet',
  restoredChip: (who: string) => `Restored · ${who}`,
  wasHidden: { hidden: 'Was hidden', removed: 'Was removed', retracted: 'Was retracted' } as const,
  undo: 'Undo',

  // ── The item ──
  season: (years: string) => `Winter ${years}`,
  itemFailed: 'This item couldn’t be read',
  noSuchItem: 'Nothing on the record by that name',
  chooseAnItem: 'Choose an item to see its decisions',
  badge: {
    hidden: 'Hidden',
    removed: 'Removed',
    retracted: 'Retracted',
    kept: 'Kept',
    restored: 'Restored',
    undone: 'Undone',
    overturned: 'Overturned',
    erased: 'Erased',
    deletedBy: (first: string) => `Deleted by ${first}`,
    retractedBy: (first: string) => `Retracted by ${first}`,
  },
  /** A by-line's verb, then its moment. */
  did: {
    hidden: 'Hid it',
    removed: 'Removed it',
    retracted: 'Retracted it',
    kept: 'Kept it',
    restore: 'Restored it',
    undo: 'Undid it',
    overturn: 'Overturned it',
    deleted: 'Deleted it',
    authorRetracted: 'Retracted it',
  } as const,
  keptWhileStands: 'kept while the decision stands',
  erasedUnlessKept: (moment: string) => `erased ${moment} unless it’s kept`,
  decisionsCapped: 'Older decisions on it are not shown',
  /** The plate's heading, by what it shows. */
  asPublished: 'As it was published',
  asWritten: 'As it was written',
  asSkatersSaw: 'As skaters saw it',
  onAgain: (place: string) => `On ${place} again`,
  erasedPlate: (moment: string) => `The words were erased ${moment}`,
  erasedPlateNoDate: 'The words were erased',
  erasedAfter: (days: number, first: string) =>
    `${days} ${days === 1 ? 'day' : 'days'} after ${first} deleted it. Who decided what, and why, stays here.`,
  erasedStays: 'Who decided what, and why, stays here.',

  // ── Its life ──
  life: 'Its life',
  lines: { up: 'Visible to skaters', down: 'Out of sight' },
  posted: 'Posted',
  today: (date: string) => `${date} · today`,
  stillDown: { hidden: 'Still hidden', removed: 'Still removed', retracted: 'Still retracted' },
  onTheRecord: 'On the record',
  upNow: 'Visible to skaters',
  deletedNow: 'Deleted',
  outOfSightFor: (days: string) => `${days} out of sight`,
  keptAsEvidence: 'Kept as evidence',
  byWhom: (who: string) => `By ${who}`,
  ifRestored: 'If restored',
  ifOverturned: 'If overturned',
  ifKept: 'If kept',
  backOn: (place: string) => `Back on ${place}`,
  backUp: 'Back up',
  datedThen: (date: string) => `Dated ${date}`,
  erasedThen: (date: string) => `Erased ${date}`,
  daysAfterDeleted: (days: number, first: string) =>
    `${days} ${days === 1 ? 'day' : 'days'} after ${first} deleted it`,
  onRecordUntilOverturned: 'Held until overturned',

  // ── What a lever would do ──
  record: 'Record',
  erased: 'Erased',
  comesOff: (first: string) => `The decision comes off ${first}’s record`,
  staysDeleted: 'Stays deleted · it never comes back',
  goesOn: (first: string) => `Goes on ${first}’s record, with the reason given`,
  keptUntilOverturned: 'Stays deleted · kept until the decision is overturned',
  atOnce: 'At once',
  erasedAtOnce: 'Erased at once',
  /** An overturn whose words something else still holds: its Post's decision, an open flag. */
  erasedHeld: 'Not erased while anything else holds it',
  comesBack: 'Comes back with it',
  cameBack: 'Came back with it',
  backComments: 'Comments',
  backThumbs: 'Thumbs',
  noneOf: 'None',
  erasedWhen: (date: string, days: number, first: string) =>
    `${date} · ${days} ${days === 1 ? 'day' : 'days'} after ${first} deleted it`,

  // ── The levers ──
  lever: {
    restore: 'Restore',
    hideAgain: 'Hide again',
    overturn: 'Overturn',
    keep: 'Keep on the record',
  } as const,
  /** A press on its way: the button keeps its place and its width. */
  busy: {
    restore: 'Restoring',
    hideAgain: 'Hiding',
    overturn: 'Overturning',
    keep: 'Keeping',
  } as const,
  undoTheRestore: 'Undo the restore',
  /** The pane's Undo on the write that ended its newest decision, by how it ended. */
  undoTheEnd: {
    restore: 'Undo the restore',
    undo: 'Put the decision back',
    overturn: 'Undo the overturn',
  } as const,
  /** What the undo dialog says is being undone, for an ending that was itself an undo. */
  decisionUndone: (kind: string) => `The decision on this ${kind} was undone`,
  /** What the undo dialog says is being undone, for an overturn. */
  decisionOverturned: (kind: string) => `The decision on this ${kind} was overturned`,
  cantUndo: 'Can’t undo',
  somethingWrong: 'Something went wrong. Try again.',
  anotherOnItsWay: 'A change to this is already on its way.',
  /** A dialog closed because what it would do changed under it (someone else acted). */
  changedWhileOpen: 'This changed while it was open.',

  // ── The dialogs ──
  hideAgainTitle: 'Hide this again?',
  hideAgainBody: (name: string) =>
    `It goes out of sight for skaters and back on ${name}’s record. Undo stays in the toast and History.`,
  keepTitle: 'Keep this on the record?',
  keepBody: (name: string, kind: string) =>
    `It goes on ${name}’s record with the reason given. The ${kind} stays deleted and is kept until the decision is overturned.`,
  overturnTitle: 'Overturn this decision?',
  /**
   * `erased`: a day ("Sun 25 Oct"), `'atOnce'`, `'already'` (its words were erased before), or
   * `null` while something else holds it.
   */
  overturnBody: (
    name: string,
    kind: string,
    erased: string | 'atOnce' | 'already' | 'unrecorded' | null,
  ) =>
    erased === 'unrecorded'
      ? `It comes off ${name}’s record. The ${kind} stays deleted.`
      : erased === null
        ? `It comes off ${name}’s record. The ${kind} stays deleted, and isn’t erased while anything else holds it.`
        : erased === 'atOnce'
          ? `It comes off ${name}’s record. The ${kind} stays deleted and is erased at once.`
          : erased === 'already'
            ? `It comes off ${name}’s record. The ${kind} stays deleted; its words were already erased.`
            : `It comes off ${name}’s record. The ${kind} stays deleted and is erased ${erased}.`,
  reasonLabel: 'Reason · kept in the audit log',
  reasonOptionalLabel: 'Reason · optional · kept in the audit log',
  reasonOptionalPlaceholder: 'Why, if there’s something to say',

  // ── The Post's chooser ──
  chooserTitle: 'Restore the post',
  itsReports: 'Its reports',
  report: 'Report',
  downBy: (verb: string, who: string) => `${verb} by ${who}`,
  downVerb: { hide: 'Hidden', remove: 'Removed' } as Record<string, string>,
  downOther: 'Taken down',
  someone: 'someone not recorded yet',
  memberDeleted: (date: string | null) =>
    date === null
      ? 'Deleted by its author, so it can’t come back with the post'
      : `Deleted by its author ${date}, so it can’t come back with the post`,
  memberUp: 'Already up',
  memberReturns: 'Comes back with the post',
  restoreWith: (n: number) => `Restore with ${n} ${n === 1 ? 'report' : 'reports'}`,
  cancel: 'Cancel',
  chooserFailed: 'Its reports couldn’t be read',

  // ── The receipts ──
  backOnPlace: (kind: string, place: string) => `The ${kind} is back on ${place}`,
  backUpReceipt: (kind: string) => `The ${kind} is back up`,
  hiddenAgainReceipt: (kind: string) => `The ${kind} is hidden again`,
  offRecordReceipt: (name: string) => `The decision is off ${name}’s record`,
  staysDeletedReceipt: (kind: string, erased: string | null) =>
    erased === null ? `The ${kind} stays deleted` : `The ${kind} stays deleted · erased ${erased}`,
  keptReceipt: (kind: string, name: string) => `The ${kind} is on ${name}’s record`,
  keptReceiptBody: 'Kept until the decision is overturned',
  withReports: (n: number) =>
    `${n.toLocaleString('en-US')} ${n === 1 ? 'report' : 'reports'} came back with it`,
  /** A refusal's toast, naming whose it is — as a receipt does. */
  refusalOf: (name: string) => (name === '' ? 'Not changed' : `Not changed · ${name}`),
  cameBackReceipt: (what: string) => `Its ${what} came back with it`,
} as const;
