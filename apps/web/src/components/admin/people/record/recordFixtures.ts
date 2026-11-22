/**
 * Board fixtures for the record sheet (8.7–8.9) and its states — **stories and tests only**
 * (`fixturesStayInStories.test.ts` holds the app to that). The clock is pinned at local midday on
 * Wed 14 Oct 2026, the boards' day, so every runner reads the same words. Every person is invented.
 */
import type { Id } from '@skating/convex/dataModel';

import type {
  ChoicesRead,
  DeletedRow,
  ItemRead,
  RecordCounts,
  RecordLevers,
  RecordPerson,
  RecordPresence,
  RecordSubject,
  ReversedRow,
  StandingRow,
} from './recordModel';

export const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();

/** The boards' day: Wed 14 Oct 2026, local midday. */
export const NOW = at(10, 14);

const uid = (s: string) => s.padEnd(32, '0') as Id<'profiles'>;
const person = (key: string, displayName: string, username: string): RecordPerson => ({
  userId: uid(key),
  displayName,
  username,
  profileImageUrl: null,
});

/** Whose record it is. */
export const SUBJECT: RecordSubject = {
  userId: uid('rob'),
  displayName: 'Rob Tremblay',
  username: 'rtremblay',
  profileImageUrl: null,
};
export const ROB = person('rob', 'Rob Tremblay', 'rtremblay');
/** The moderators who decided, and the one reading. */
export const ANA = person('ana', 'Ana Ruiz', 'aruiz');
export const BEN = person('ben', 'Ben Okafor', 'bokafor');
export const DANA = person('dana', 'Dana Lee', 'dlee');
/** Report authors a comment was on. */
export const KATE = person('kate', 'Kate Donovan', 'kdonovan');
export const LUC = person('luc', 'Luc Pelletier', 'lpelletier');
export const JAMIE = person('jamie', 'Jamie Moreau', 'jmoreau');

export const LEAVING = 'Your account is being deleted, so you can no longer change this.';
export const CHECK_ON_ITEM = 'Open it to see what can be done with it.';
export const AUTHOR_DELETED =
  'Its author deleted this, so it stays as they left it. Overturn the decision to take it off their record.';
export const ALREADY_UP = 'This is already up.';

export const yes = (needsReason = false, needsChoice?: boolean) =>
  ({ ok: true, needsReason, ...(needsChoice !== undefined ? { needsChoice } : {}) }) as const;
export const no = (why: string) => ({ ok: false, why }) as const;

const bodyId = (name: string) => `body-${name}` as Id<'waterBodies'>;
const place = (waterBodyName: string | null, extra: Partial<StandingRow> = {}) => ({
  waterBodyId: waterBodyName === null ? null : bodyId(waterBodyName),
  waterBodyName,
  reportAuthor: null,
  postReportCount: null,
  ...extra,
});

// ── Standing (8.7) ───────────────────────────────────────────────────────────────────────────

export const STANDING: StandingRow[] = [
  {
    targetType: 'report',
    targetId: 'r4oct',
    kind: 'hidden',
    at: at(10, 10, 19, 48),
    reason: 'Second unsafe claim this week',
    byUserId: ANA.userId,
    decidedBy: ANA,
    kept: false,
    content: { at: at(10, 4, 16, 40), text: 'Drilled off the town beach: 3½" of black ice.' },
    authorDeletedAt: null,
    ...place('Mascoma Lake'),
    can: { restore: yes() },
  },
  {
    targetType: 'accessAlert',
    targetId: 'alert',
    kind: 'retracted',
    at: at(10, 2, 9, 30),
    reason: 'Third false gate claim this month',
    byUserId: ANA.userId,
    decidedBy: ANA,
    kept: true,
    content: {
      at: at(9, 30, 7, 12),
      title: 'gate_locked',
      text: 'Gate locked at the north launch',
    },
    authorDeletedAt: at(10, 1, 18, 40),
    ...place('Mascoma Lake'),
    can: { overturn: yes() },
  },
  {
    targetType: 'comment',
    targetId: 'ckate',
    kind: 'hidden',
    at: at(10, 2, 8, 0),
    reason: 'Name-calling; second warning',
    byUserId: BEN.userId,
    decidedBy: BEN,
    kept: false,
    content: { at: at(10, 1, 20, 0), text: 'Nobody asked you, Kate. Stay off my lake.' },
    authorDeletedAt: null,
    ...place('Crystal Lake', { reportAuthor: KATE }),
    can: { restore: yes() },
  },
  {
    targetType: 'post',
    targetId: 'post',
    kind: 'hidden',
    at: at(9, 26, 10, 0),
    reason: 'Each report repeats the same 4 inches',
    byUserId: BEN.userId,
    decidedBy: BEN,
    kept: false,
    content: { at: at(9, 27, 16, 0), title: 'Opening weekend on Mascoma', text: null },
    authorDeletedAt: null,
    ...place('Mascoma Lake', { postReportCount: 3 }),
    can: { restore: no(CHECK_ON_ITEM) },
  },
  {
    targetType: 'comment',
    targetId: 'cthermo',
    kind: 'hidden',
    at: at(9, 23, 21, 10),
    reason: 'Hostile tone, third time this month',
    byUserId: ANA.userId,
    decidedBy: ANA,
    kept: false,
    content: { at: at(9, 22, 19, 44), text: 'Learn to read a thermometer.' },
    authorDeletedAt: at(9, 25, 8, 2),
    ...place('Lake Morey', { reportAuthor: LUC }),
    can: { overturn: yes() },
  },
  {
    targetType: 'report',
    targetId: 'rbasin',
    kind: 'removed',
    at: at(3, 19, 10, 0),
    reason: 'Duplicate of his 17 Mar report',
    byUserId: ANA.userId,
    decidedBy: ANA,
    kept: false,
    content: { at: at(3, 18, 15, 0), text: 'Skated the whole north basin' },
    authorDeletedAt: null,
    ...place('Mascoma Lake'),
    can: { restore: yes() },
  },
];

// ── Deleted (8.9) ────────────────────────────────────────────────────────────────────────────

export const DELETED: DeletedRow[] = [
  {
    targetType: 'comment',
    targetId: 'dstop',
    deletedAt: at(10, 9, 22, 15),
    eraseAt: at(11, 8, 22, 15),
    content: { at: at(10, 9, 21, 58), text: 'Fine, I’ll stop posting here.' },
    waterBodyId: bodyId('Lake Morey'),
    waterBodyName: 'Lake Morey',
    reportAuthor: JAMIE,
    postReportCount: null,
    can: { keep: yes(true) },
  },
  {
    targetType: 'report',
    targetId: 'dinlet',
    deletedAt: at(10, 3, 9, 0),
    eraseAt: null,
    content: { at: at(10, 2, 15, 0), text: 'Thin at the inlet, stay off' },
    waterBodyId: bodyId('Mascoma Lake'),
    waterBodyName: 'Mascoma Lake',
    reportAuthor: null,
    postReportCount: null,
    can: { keep: yes(true) },
  },
];

// ── Reversed (8.9) ───────────────────────────────────────────────────────────────────────────

export const REVERSED: ReversedRow[] = [
  {
    targetType: 'comment',
    targetId: 'xguess',
    kind: 'hidden',
    decidedAt: at(9, 26, 18, 30),
    decidedBy: ANA,
    kept: false,
    reason: 'Hostile tone',
    endedAt: at(9, 28, 10, 12),
    endedBy: BEN,
    endedHow: 'restore',
    endedReason: null,
    endActionId: 'end-xguess',
    undo: { state: 'unavailable', why: 'Its author deleted this, so it stays as they left it.' },
    erasedAt: null,
    content: { at: at(9, 26, 9, 0), text: 'That’s a guess, not a measurement.' },
    authorDeletedAt: at(9, 29, 7, 45),
    waterBodyId: null,
    waterBodyName: null,
    reportAuthor: JAMIE,
    postReportCount: null,
    can: { keep: yes(true) },
  },
  {
    targetType: 'report',
    targetId: 'xerased',
    kind: 'removed',
    decidedAt: at(2, 3, 10, 5),
    decidedBy: ANA,
    kept: false,
    reason: 'Claimed 6 inches over open water',
    endedAt: at(2, 6, 16, 20),
    endedBy: BEN,
    endedHow: 'overturn',
    endedReason: 'Appeal upheld: wrong lake in the photo',
    endActionId: 'end-xerased',
    undo: { state: 'unavailable', why: 'An overturn can’t be undone.' },
    erasedAt: at(3, 6, 4, 0),
    content: null,
    authorDeletedAt: null,
    waterBodyId: bodyId('Mascoma Lake'),
    waterBodyName: 'Mascoma Lake',
    reportAuthor: null,
    postReportCount: null,
    can: {},
  },
] as ReversedRow[];

// ── Pages and counts ─────────────────────────────────────────────────────────────────────────

export function page<R>(
  rows: R[],
  o: { isDone?: boolean; pending?: boolean; cursor?: string } = {},
) {
  return {
    page: rows,
    isDone: o.isDone ?? true,
    continueCursor: o.cursor ?? (o.isDone === false ? 'next' : ''),
    pending: o.pending === true ? (['verdicts'] as const) : ([] as const),
  } as unknown as {
    page: R[];
    isDone: boolean;
    continueCursor: string;
    pending: ['verdicts'] | [];
  };
}

const kinds = (o: Partial<Record<StandingRow['targetType'], number>> = {}) => ({
  report: 0,
  post: 0,
  comment: 0,
  hazard: 0,
  accessAlert: 0,
  ...o,
});

/** Standing's count, as `people.person.hidden` says it: 2 reports · 1 post · 2 comments · 1 alert. */
export const HIDDEN = {
  total: 6,
  capped: false,
  byKind: kinds({ report: 2, post: 1, comment: 2, accessAlert: 1 }),
};
export const HIDDEN_NONE = { total: 0, capped: false, byKind: kinds() };
export const HIDDEN_CAPPED = {
  total: 500,
  capped: true,
  byKind: kinds({ report: 412, comment: 88 }),
};

export const COUNTS: RecordCounts = {
  reversed: { count: 2, capped: false, byKind: kinds({ report: 1, comment: 1 }) },
  deleted: { count: 2, capped: false, byKind: kinds({ report: 1, comment: 1 }) },
  pending: [],
} as RecordCounts;
export const COUNTS_PENDING: RecordCounts = { ...COUNTS, pending: ['verdicts'] } as RecordCounts;

/** `recordPresence`: whether Deleted and Reversed would show anything. */
export const PRESENCE: RecordPresence = { deleted: true, reversed: true, pending: [] };
export const PRESENCE_NONE: RecordPresence = { deleted: false, reversed: false, pending: [] };

// ── Items ────────────────────────────────────────────────────────────────────────────────────

type Doc = Record<string, unknown>;
const report = (o: Doc = {}) => ({
  _id: 'r4oct',
  skateEndTime: at(10, 4, 16, 40),
  notes:
    'Drilled off the town beach: 3½" of black ice. Second night under 25. Stayed inside the swim line.',
  moderationStatus: 'hidden',
  ...o,
});
const comment = (o: Doc = {}) => ({
  _id: 'cthermo',
  createdAt: at(9, 22, 19, 44),
  body: 'Learn to read a thermometer. You were never out at the inlet and everyone on this lake knows it.',
  moderationStatus: 'removed',
  ...o,
});

function item(
  o: Omit<Partial<ItemRead>, 'published'> & {
    targetType: ItemRead['targetType'];
    targetId: string;
    can: RecordLevers;
    published?: Doc | null;
  },
): ItemRead {
  const published = o.published ?? null;
  return {
    // The words, as the server's `contentOf` reads them from the document.
    content: published === null ? null : contentOf(o.targetType, published),
    eraseAtIfReleased: null,
    comesBack: null,
    erasedAt: null,
    authorDeletedAt: null,
    eraseAt: null,
    waterBodyId: bodyId('Mascoma Lake'),
    waterBodyName: 'Mascoma Lake',
    reportAuthor: null,
    postReportCount: null,
    decisions: [],
    decisionsCapped: false,
    pending: [],
    ...o,
    published: (o.published ?? null) as unknown as ItemRead['published'],
  } as ItemRead;
}

function contentOf(kind: ItemRead['targetType'], d: Doc): ItemRead['content'] {
  const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
  switch (kind) {
    case 'report':
      return { at: num('skateEndTime'), text: str('notes') };
    case 'post':
      return { at: num('latestSkateEndTime'), title: str('title'), text: str('body') };
    case 'comment':
      return { at: num('createdAt'), text: str('body') };
    case 'hazard':
      return { at: num('firstReportedAt'), title: str('type'), text: str('description') };
    case 'accessAlert':
      return { at: num('createdAt'), title: str('reason'), text: str('note') };
  }
}

/** A report's one comment still up and its two thumbs (8.7–8.8). */
const BACK = { comments: { count: 1, capped: false }, ratings: { count: 2, capped: false } };

const decision = (o: Partial<ItemRead['decisions'][number]>): ItemRead['decisions'][number] => ({
  kind: 'hidden',
  at: at(10, 10, 19, 48),
  standing: true,
  decidedBy: ANA,
  reason: 'Second unsafe claim this week',
  kept: false,
  endedAt: null,
  endedBy: null,
  endedHow: null,
  endedReason: null,
  ...o,
});

/** 8.8 before: a hidden report — Restore, no reason asked. */
export const ITEM_HIDDEN = item({
  targetType: 'report',
  targetId: 'r4oct',
  published: report(),
  comesBack: BACK,
  decisions: [decision({})],
  can: { restore: yes() },
});

/** 8.8 after: the same report, just restored — Hide again. */
export const ITEM_RESTORED = item({
  targetType: 'report',
  targetId: 'r4oct',
  published: report({ moderationStatus: 'visible' }),
  comesBack: BACK,
  decisions: [
    decision({
      standing: false,
      endedAt: at(10, 14, 11, 52),
      endedBy: DANA,
      endedHow: 'restore',
      endedReason: null,
    }),
  ],
  can: { hideAgain: yes(true) },
});

/** 8.7: a comment hidden, then deleted by its author — kept as evidence; Overturn. */
export const ITEM_DELETED = item({
  targetType: 'comment',
  targetId: 'cthermo',
  published: comment(),
  waterBodyName: 'Lake Morey',
  reportAuthor: LUC,
  authorDeletedAt: at(9, 25, 8, 2),
  // Thirty days after the deletion, nothing else holding it.
  eraseAtIfReleased: at(10, 25, 8, 2),
  decisions: [decision({ at: at(9, 23, 21, 10), reason: 'Hostile tone, third time this month' })],
  can: { overturn: yes() },
});

/** 8.9: something they deleted that no decision holds — Keep on the record. */
export const ITEM_WITHDRAWN = item({
  targetType: 'comment',
  targetId: 'dstop',
  published: comment({
    _id: 'dstop',
    createdAt: at(10, 9, 21, 58),
    body: 'Fine, I’ll stop posting here. Enjoy your thin ice and your opinions.',
  }),
  waterBodyName: 'Lake Morey',
  reportAuthor: JAMIE,
  authorDeletedAt: at(10, 9, 22, 15),
  eraseAt: at(11, 8, 22, 15),
  can: { keep: yes(true) },
});

/** 8.9: overturned, then erased — the words are gone, the decision stays; no lever. */
export const ITEM_ERASED = item({
  targetType: 'report',
  targetId: 'xerased',
  published: null,
  erasedAt: at(3, 6, 4, 0),
  decisions: [
    decision({
      kind: 'removed',
      at: at(2, 3, 10, 5),
      standing: false,
      reason: 'Claimed 6 inches over open water',
      endedAt: at(2, 6, 16, 20),
      endedBy: BEN,
      endedHow: 'overturn',
      endedReason: 'Appeal upheld: wrong lake in the photo',
    }),
  ],
  can: {},
});

/** 8.9: a hidden Post whose Reports each went down on their own — Restore opens the chooser. */
export const ITEM_POST = item({
  targetType: 'post',
  targetId: 'post',
  published: {
    _id: 'post',
    latestSkateEndTime: at(9, 27, 16, 0),
    title: 'Opening weekend on Mascoma',
    moderationStatus: 'hidden',
    reportIds: ['m1', 'm2', 'm3'],
  },
  postReportCount: 3,
  decisions: [
    decision({
      at: at(9, 26, 10, 0),
      decidedBy: BEN,
      reason: 'Each report repeats the same 4 inches',
    }),
  ],
  can: { restore: yes(false, true) },
});

/** 8.9: a viewer in their own deletion window — sees it, can't act; the foot says why. */
export const ITEM_LEAVING = { ...ITEM_HIDDEN, can: { restore: no(LEAVING) } } as ItemRead;

/** 8.9: an undo that ran out — restored, then deleted by its author. */
export const ITEM_UNDO_GONE = item({
  targetType: 'comment',
  targetId: 'xguess',
  published: comment({
    _id: 'xguess',
    createdAt: at(9, 26, 9, 0),
    body: 'That’s a guess, not a measurement. Drill before you post.',
    moderationStatus: 'removed',
  }),
  waterBodyName: null,
  reportAuthor: JAMIE,
  authorDeletedAt: at(9, 29, 7, 45),
  decisions: [
    decision({
      at: at(9, 26, 18, 30),
      standing: false,
      reason: 'Hostile tone',
      endedAt: at(9, 28, 10, 12),
      endedBy: BEN,
      endedHow: 'restore',
      endActionId: 'end-xguess' as Id<'moderationActions'>,
      undo: { state: 'unavailable', why: 'Its author deleted this, so it stays as they left it.' },
    }),
  ],
  can: { keep: yes(true) },
});

/** The chooser's members (8.9 *A post*): two choosable, one its author deleted. */
export const CHOICES: ChoicesRead = {
  postStatus: 'hidden',
  plainRestoreBringsBack: false,
  restorable: true,
  prompt:
    'Every report in this post was hidden or removed on its own. Choose at least one report to restore with it.',
  members: [
    {
      reportId: 'm1' as Id<'reports'>,
      status: 'hidden',
      waterBodyName: 'Mascoma Lake',
      skateEndTime: at(9, 26, 15, 0),
      down: {
        action: 'hide',
        by: { userId: ANA.userId, username: 'aruiz', displayName: 'Ana Ruiz' },
        at: at(9, 26, 18, 0),
        reason: 'Same 4 inches as the others',
      },
      standing: 'choose',
      authorDeletedAt: null,
    },
    {
      reportId: 'm2' as Id<'reports'>,
      status: 'removed',
      waterBodyName: 'Mascoma Lake',
      skateEndTime: at(9, 27, 15, 0),
      down: {
        action: 'remove',
        by: { userId: BEN.userId, username: 'bokafor', displayName: 'Ben Okafor' },
        at: at(9, 27, 18, 0),
        reason: 'Photo from a different lake',
      },
      standing: 'choose',
      authorDeletedAt: null,
    },
    {
      reportId: 'm3' as Id<'reports'>,
      status: 'removed',
      waterBodyName: 'Mascoma Lake',
      skateEndTime: at(9, 27, 16, 0),
      standing: 'author_deleted',
      authorDeletedAt: at(9, 28, 9, 0),
    },
  ],
} as ChoicesRead;

/**
 * A photo verdict (B01-5e): a photo removed from a report. The read doesn't serve the kind yet (the
 * server's photo axis lands with its own builder), so it is carried past the type; its content's
 * `thumbUrl` is the staff-only thumbnail the item read owes.
 */
export const ITEM_PHOTO = {
  ...item({
    targetType: 'report',
    targetId: 'ph_3',
    decisions: [decision({ kind: 'removed', reason: 'Children’s faces, close up' })],
    can: { restore: yes() },
  }),
  targetType: 'photo',
  content: {
    at: at(10, 11, 14, 22),
    text: null,
    thumbUrl:
      'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22250%22%3E%3Crect%20width%3D%22400%22%20height%3D%22250%22%20fill%3D%22%23585c60%22%2F%3E%3C%2Fsvg%3E',
  },
} as unknown as ItemRead;

/** The same verdict, its file deleted (or a viewer served no photos): no address. */
export const ITEM_PHOTO_NONE = {
  ...ITEM_PHOTO,
  content: { at: at(10, 11, 14, 22), text: null, thumbUrl: null },
} as unknown as ItemRead;
