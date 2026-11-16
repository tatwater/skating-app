import type { api } from '@skating/convex/api';
import {
  ACCESS_REASON_LABELS,
  type AccessReason,
  type HazardType,
  hazardTypeLabel,
  seasonOf,
  WITHDRAWN_ERASE_MS,
} from '@skating/core';
import type { FunctionReturnType } from 'convex/server';

import { historyWhen, seasonYears } from '../../shell/consoleTime';
import { floorText, settledEmpty } from '../answers';
import { dateWords, firstName, momentWords, personName } from '../person/personModel';
import { WORDS as PERSON_WORDS } from '../person/personWords';
import {
  KIND_ORDER,
  KIND_WORDS,
  kindCount,
  type RecordKind,
  RECORD_WORDS as W,
} from './recordWords';

/**
 * **The record sheet's view model** (boards 8.7–8.9) — pure: the server's answers in, what the sheet
 * draws out. Nothing here decides what a viewer may do: **`can` is the law** ({@link leverOf}), and a
 * refusal is the server's sentence, shown as written.
 *
 * - **Three lists**: Standing (`contentRecord.personVerdicts`), Deleted (`personDeleted`), Reversed
 *   (`personReversed`) — each a chain of pages; a short page is not the end, `isDone` is.
 * - **Three answers that aren't a number**: still being prepared (`pending: ['verdicts']`), a floor
 *   (`capped`, or a list with pages still to come), and not recorded (`null`) — never a zero.
 * - **One item, one read** (`contentRecord.item`): its decisions, who made them and why, its life,
 *   and the one lever its state offers this viewer.
 */

// ── The server's shapes ──────────────────────────────────────────────────────────────────────

export type StandingPage = FunctionReturnType<typeof api.contentRecord.personVerdicts>;
export type DeletedPage = FunctionReturnType<typeof api.contentRecord.personDeleted>;
export type ReversedPage = FunctionReturnType<typeof api.contentRecord.personReversed>;
export type StandingRow = StandingPage['page'][number];
export type DeletedRow = DeletedPage['page'][number];
export type ReversedRow = ReversedPage['page'][number];
export type RecordCounts = FunctionReturnType<typeof api.contentRecord.recordCounts>;
/** Whether Deleted and Reversed would show anything — the person page's cheap read. */
export type RecordPresence = FunctionReturnType<typeof api.contentRecord.recordPresence>;
export type ItemRead = NonNullable<FunctionReturnType<typeof api.contentRecord.item>>;
export type ChoicesRead = NonNullable<FunctionReturnType<typeof api.moderation.postRestoreChoices>>;
export type RecordLevers = ItemRead['can'];
export type RecordPerson = NonNullable<StandingRow['decidedBy']>;
export type RecordContent = NonNullable<StandingRow['content']>;
export type Decision = ItemRead['decisions'][number];

export type RecordTab = 'standing' | 'deleted' | 'reversed';
export const TABS: readonly RecordTab[] = ['standing', 'deleted', 'reversed'];

/** Any row, by the list it came from. */
export type AnyRow =
  | { tab: 'standing'; row: StandingRow }
  | { tab: 'deleted'; row: DeletedRow }
  | { tab: 'reversed'; row: ReversedRow };

/** An item's identity across the lists and the pane. */
export type Target = { targetType: RecordKind; targetId: string };
export const targetKey = (t: Target): string => `${t.targetType}:${t.targetId}`;

/** The person whose record it is, as the sheet names them. */
export type RecordSubject = {
  userId: string;
  displayName: string | null;
  username: string | null;
  profileImageUrl: string | null;
};

/** The words a by-line or a row says for a person: their name, or *Not recorded yet*. */
export const nameOf = (p: RecordPerson | null | undefined): string | null =>
  p == null ? null : personName(p);
/** Staff and authors are named by first name in prose (the boards' rule). */
export const firstOf = (p: RecordPerson | RecordSubject | null | undefined): string => {
  const name = p == null ? null : personName(p);
  return name === null ? W.notRecorded : firstName(name);
};
/** The subject's full name, for a dialog or a receipt: their name, or their handle. */
export const subjectName = (s: RecordSubject): string => personName(s) ?? s.username ?? '';

// ── The lever ────────────────────────────────────────────────────────────────────────────────

export type RecordAction = 'restore' | 'hideAgain' | 'overturn' | 'keep';
/** The order the levers are read in, should a `can` ever carry more than one. */
export const ACTION_ORDER: readonly RecordAction[] = ['restore', 'hideAgain', 'overturn', 'keep'];
/** Each lever's key on a fine pointer (the boards' R, H, O, K). */
export const ACTION_KEY: Readonly<Record<RecordAction, string>> = {
  restore: 'R',
  hideAgain: 'H',
  overturn: 'O',
  keep: 'K',
};

export type Lever =
  | { action: RecordAction; ok: true; needsReason: boolean; needsChoice: boolean }
  | { action: RecordAction; ok: false; why: string };

/**
 * **The one lever an item offers this viewer, exactly as the server answered** — the first answer
 * that lets them act; else the first refusal, whose `why` the foot says as written; else nothing.
 * The server sends one at most; were it ever to send more, the fixed order decides, and a refused
 * lever is never drawn as a button.
 */
export function leverOf(can: RecordLevers | null | undefined): Lever | null {
  if (can == null) return null;
  const answers = ACTION_ORDER.flatMap((action) => {
    const answer = can[action];
    return answer === undefined ? [] : [{ action, answer }];
  });
  const open = answers.find((a) => a.answer.ok);
  if (open?.answer.ok) {
    return {
      action: open.action,
      ok: true,
      needsReason: open.answer.needsReason,
      needsChoice: open.answer.needsChoice === true,
    };
  }
  const refused = answers[0];
  if (refused === undefined || refused.answer.ok) return null;
  return { action: refused.action, ok: false, why: refused.answer.why };
}

// ── Words for a thing on the record ──────────────────────────────────────────────────────────

/** What a row or a plate says of an item's words: quoted when written, plain when not. */
export type Title = { text: string; quoted: boolean; gone: boolean };

/** The title a row shows: the words as written, or what stands in for them. */
export function titleOf(kind: RecordKind, content: RecordContent | null): Title {
  if (content === null) return { text: W.wordsErased, quoted: false, gone: true };
  const text = content.text?.trim() || null;
  const title = content.title?.trim() || null;
  switch (kind) {
    case 'post':
      if (title !== null) return { text: title, quoted: true, gone: false };
      break;
    case 'hazard':
      if (text === null && title !== null) {
        return { text: hazardTypeLabel(title as HazardType), quoted: false, gone: false };
      }
      break;
    case 'accessAlert':
      if (text === null && title !== null) {
        return { text: alertReason(title), quoted: false, gone: false };
      }
      break;
  }
  return text === null
    ? { text: W.noWords, quoted: false, gone: true }
    : { text, quoted: true, gone: false };
}

const alertReason = (reason: string): string =>
  ACCESS_REASON_LABELS[reason as AccessReason] ?? reason;

/** A title as text, quoted when it is someone's words. */
export const titleText = (t: Title): string => (t.quoted ? `“${t.text}”` : t.text);

/** The item's place: a comment's Report, the body, a Post's Reports. */
type Place = {
  waterBodyName: string | null;
  reportAuthor: RecordPerson | null;
  postReportCount: number | null;
};

/** Where an item is, said as its rows say it: "On Kate Donovan’s report · Crystal Lake". */
function whereParts(kind: RecordKind, place: Place): string[] {
  const parts: string[] = [];
  if (kind === 'comment') {
    const author = nameOf(place.reportAuthor);
    parts.push(author === null ? W.onAReport : W.onReportOf(author));
  }
  if (place.waterBodyName !== null) parts.push(place.waterBodyName);
  return parts;
}

/** The place a receipt or an *If restored* station names: the body, or a comment's Report. */
export function placeName(kind: RecordKind, place: Place): string | null {
  if (kind === 'comment') {
    const author = nameOf(place.reportAuthor);
    return author === null ? null : `${author}’s report`;
  }
  return place.waterBodyName;
}

/** What follows the place: a Post's Reports, or the day it was made. */
function whenPart(
  kind: RecordKind,
  place: Place,
  content: RecordContent | null,
  now: number,
  tz?: string,
): string[] {
  if (kind === 'post' && place.postReportCount !== null) {
    return [W.reportsInPost(place.postReportCount)];
  }
  return content === null ? [] : [dateWords(content.at, now, tz)];
}

// ── A row ────────────────────────────────────────────────────────────────────────────────────

export type Chip = { label: string; lit?: boolean };
/** A line under a row's title: plain words, or a label and the quoted reason after it. */
export type Line = { text: string; quote?: string };

export type RowView = {
  key: string;
  target: Target;
  chips: Chip[];
  title: Title;
  lines: Line[];
  /** The right column: an age, or a restore's time. */
  meta: string;
};

const reasonLine = (reason: string | null): Line =>
  reason === null ? { text: W.reasonUnrecorded } : { text: `${W.reason}: `, quote: reason };

/** Whether a decision was taken on something already deleted — kept as evidence. */
const keptAfter = (at: number, authorDeletedAt: number | null): boolean =>
  authorDeletedAt !== null && at >= authorDeletedAt;

/** The author's own withdrawal, as a chip: an alert's is a retraction. */
const withdrawnChip = (kind: RecordKind): string =>
  kind === 'accessAlert' ? W.retractedChip : W.deletedChip;

export function standingRowView(row: StandingRow, now: number, tz?: string): RowView {
  const kind = row.targetType;
  const kept = keptAfter(row.at, row.authorDeletedAt);
  const states = kept
    ? [withdrawnChip(kind), W.keptChip]
    : [W.verdict[row.kind], ...(row.authorDeletedAt !== null ? [withdrawnChip(kind)] : [])];
  const verdictWord = kept ? W.keptChip : W.verdict[row.kind];
  return {
    key: targetKey(row),
    target: { targetType: kind, targetId: row.targetId },
    chips: [{ label: KIND_WORDS[kind].one }, ...states.map((label) => ({ label }))],
    title: titleOf(kind, row.content),
    lines: [
      {
        text: [
          ...whereParts(kind, row),
          ...whenPart(kind, row, row.content, now, tz),
          `${verdictWord} ${dateWords(row.at, now, tz)}`,
        ].join(' · '),
      },
      reasonLine(row.reason),
    ],
    meta: W.rowAge(now - row.at),
  };
}

export function deletedRowView(row: DeletedRow, now: number, tz?: string): RowView {
  const kind = row.targetType;
  return {
    key: targetKey(row),
    target: { targetType: kind, targetId: row.targetId },
    chips: [{ label: KIND_WORDS[kind].one }, { label: withdrawnChip(kind) }],
    title: titleOf(kind, row.content),
    lines: [
      {
        text: [...whereParts(kind, row), ...whenPart(kind, row, row.content, now, tz)].join(' · '),
      },
      {
        // An alert's withdrawal is its author's retraction, as its chip says.
        text: `${(kind === 'accessAlert' ? W.retractedThen : W.deletedThen)(dateWords(row.deletedAt, now, tz))} · ${
          row.eraseAt === null ? W.eraseUnrecorded : W.erasedOn(dateWords(row.eraseAt, now, tz))
        }`,
      },
    ],
    meta: W.rowAge(now - row.deletedAt),
  };
}

export function reversedRowView(row: ReversedRow, now: number, tz?: string): RowView {
  const kind = row.targetType;
  // A list row is each item's newest decision, so a later one never superseded it.
  const how = row.endedHow === 'superseded' ? null : row.endedHow;
  const ended = how === null ? null : W.ended[how];
  const who = row.endedBy === null ? null : firstOf(row.endedBy);
  return {
    key: targetKey(row),
    target: { targetType: kind, targetId: row.targetId },
    chips: [
      { label: KIND_WORDS[kind].one },
      ...(ended === null ? [] : [{ label: ended, lit: how !== 'overturn' }]),
      ...(row.erasedAt !== null ? [{ label: W.erasedChip }] : []),
    ],
    title: titleOf(kind, row.content),
    lines: [
      {
        text: [
          ...whereParts(kind, row),
          `${W.verdict[row.kind]} ${dateWords(row.decidedAt, now, tz)}`,
          ...(ended === null ? [] : [`${ended} ${dateWords(row.endedAt, now, tz)}`]),
        ].join(' · '),
      },
      row.erasedAt !== null
        ? { text: W.erasedLine(dateWords(row.erasedAt, now, tz)) }
        : who === null || how === null
          ? { text: W.whoEndedUnrecorded }
          : { text: `${who} ${W.endedBy[how]}` },
    ],
    meta: W.rowAge(now - row.endedAt),
  };
}

/**
 * **A row restored in this sitting** (8.8): it keeps its place in Standing, lit *Restored · Teagan*,
 * with the restore's time and — while the write said it can be undone — its Undo, until the sheet
 * closes or the server's answer supersedes it ({@link nextRestored}). The server's list no longer
 * holds it; the sheet does.
 */
export type Restored = {
  row: StandingRow;
  at: number;
  /** The write that made it: what it stands in for, and what its Undo undoes. */
  actionId: string;
  /** Who restored it (the viewer), for telling their restore from another hand's. */
  actorId: string | null;
  /** The write's word: whether this viewer can undo it now, and whether that asks a reason. */
  undo: { needsReason: boolean } | null;
};

/** What can supersede a row kept for the sitting. */
export type RestoredEvent =
  /** A restore landed: its row is kept, replacing any earlier one for the same item. */
  | { kind: 'kept'; restored: Restored }
  /** The server's Standing rows as loaded (`null` while on their way: nothing can be judged). */
  | { kind: 'listed'; rows: readonly StandingRow[] | null }
  /** The open item's read. */
  | { kind: 'item'; item: ItemRead };

/**
 * **The rows kept for the sitting, after `event`** — each keyed by the write that made it, dropped
 * the moment the server's answer supersedes it, and never brought back: the server lists the item
 * again (an undo — from its row or the toast — or a hide again, anyone's), or the open item's read
 * shows a decision standing on it or its last restore by another hand. An entry, once dropped, is
 * gone; a later restore by anyone is never drawn with this one's name, time or Undo. An answer that
 * supersedes nothing returns `kept` itself, so nothing redraws for it.
 */
export function nextRestored(kept: readonly Restored[], event: RestoredEvent): readonly Restored[] {
  const keep = (stays: (r: Restored) => boolean) => {
    const next = kept.filter(stays);
    return next.length === kept.length ? kept : next;
  };
  switch (event.kind) {
    case 'kept': {
      const key = targetKey(event.restored.row);
      return [...kept.filter((r) => targetKey(r.row) !== key), event.restored];
    }
    case 'listed': {
      if (event.rows === null) return kept;
      const listed = new Set(event.rows.map((r) => targetKey(r)));
      return keep((r) => !listed.has(targetKey(r.row)));
    }
    case 'item': {
      const { item } = event;
      const key = targetKey(item);
      return keep((r) => {
        if (targetKey(r.row) !== key) return true;
        if (item.decisions.some((d) => d.standing)) return false;
        const newest = [...item.decisions].sort((a, b) => b.at - a.at)[0];
        const restorer = newest?.endedBy?.userId ?? null;
        // Dropped only on what the read shows: a decision ended another way, or by another hand. A
        // restorer or a viewer not known (a name past the read's budget, a viewer read still on its
        // way) is not another hand — the list's own answer still settles it.
        if (newest === undefined) return true;
        if (newest.endedHow !== null && newest.endedHow !== 'restore' && newest.endedHow !== 'undo')
          return false;
        return restorer === null || r.actorId === null || restorer === r.actorId;
      });
    }
  }
}

export function restoredRowView(
  restored: Restored,
  viewerFirst: string,
  now: number,
  tz?: string,
): RowView {
  const { row } = restored;
  const kind = row.targetType;
  return {
    key: targetKey(row),
    target: { targetType: kind, targetId: row.targetId },
    chips: [{ label: KIND_WORDS[kind].one }, { label: W.restoredChip(viewerFirst), lit: true }],
    title: titleOf(kind, row.content),
    lines: [
      {
        text: [...whereParts(kind, row), ...whenPart(kind, row, row.content, now, tz)].join(' · '),
      },
      row.reason === null
        ? { text: `${W.wasHidden[row.kind]}: ${W.notRecorded.toLowerCase()}` }
        : { text: `${W.wasHidden[row.kind]}: `, quote: row.reason },
    ],
    meta: historyWhen(restored.at, now, tz),
  };
}

/**
 * Standing as drawn: the server's rows, and each row restored in this sitting back in its place —
 * before the first row decided before it (the list is newest first) — until the server holds it
 * again (an undo, a hide again), when the server's row is the one shown.
 */
export function withRestored(
  rows: readonly StandingRow[],
  restored: readonly Restored[],
): { rows: Array<{ row: StandingRow; restored: Restored | null }>; restoredCount: number } {
  const held = new Set(rows.map((r) => targetKey(r)));
  const out: Array<{ row: StandingRow; restored: Restored | null }> = rows.map((row) => ({
    row,
    restored: null,
  }));
  let count = 0;
  const waiting = restored
    .filter((r) => !held.has(targetKey(r.row)))
    .sort((a, b) => b.row.at - a.row.at);
  for (const r of waiting) {
    const at = out.findIndex((o) => o.row.at < r.row.at);
    out.splice(at === -1 ? out.length : at, 0, { row: r.row, restored: r });
    count++;
  }
  return { rows: out, restoredCount: count };
}

// ── A list's ends and counts ─────────────────────────────────────────────────────────────────

export type ListStatus = 'loading' | 'error' | 'fetching' | 'more' | 'done';

/**
 * What a list draws at its end: its end tab once every page is in ("All 5", "All 5 · 1 restored",
 * "2 so far" while being prepared, what an empty list is), or the skeleton row while more pages can
 * load — never an end tab then, so a floor never reads as the whole.
 */
export type ListEnd = { kind: 'end'; label: string } | { kind: 'more' } | { kind: 'none' };

export function listEnd(opts: {
  tab: RecordTab;
  kind: RecordKind | null;
  status: ListStatus;
  rows: number;
  restored: number;
  pending: boolean;
}): ListEnd {
  const { status, rows, restored, pending } = opts;
  if (status === 'loading' || status === 'error') return { kind: 'none' };
  if (status === 'more' || status === 'fetching') return { kind: 'more' };
  const shown = rows - restored;
  if (pending) return { kind: 'end', label: W.soFar(shown) };
  if (rows === 0) {
    return {
      kind: 'end',
      label: opts.kind === null ? W.empty[opts.tab] : W.emptyOfKind(opts.kind),
    };
  }
  return {
    kind: 'end',
    label: restored > 0 ? W.allWithRestored(shown, restored) : W.all(shown),
  };
}

/** Standing's count: `people.person`'s `hidden`, and whether the record is still being prepared. */
export type StandingCount = {
  total: number;
  capped: boolean;
  byKind: Readonly<Record<RecordKind, number>>;
};

/** The head's count — what stands on the record: "6 items", "500+ items", *Still being prepared*. */
export function headCount(standing: StandingCount | null, pending: boolean): string | null {
  if (pending) return W.pending;
  return standing === null ? null : standingWords(standing, false);
}

/**
 * What stands, in words — the sheet's head and the person page's *On the record* row, one rule:
 * *Still being prepared*, a floor that read none in words (never a zero), else "6 items", "500+".
 */
export function standingWords(standing: StandingCount, pending: boolean): string {
  if (pending) return W.pending;
  if (standing.total === 0 && standing.capped) return PERSON_WORDS.recordUncounted;
  return W.items(standing.total, standing.capped);
}

/** Every count in a tab, by kind — Standing's from the person read, the others from the counts. */
export function tabCounts(
  tab: RecordTab,
  standing: StandingCount | null,
  counts: RecordCounts | null,
): { byKind: Readonly<Record<RecordKind, number>>; capped: boolean } | null {
  if (tab === 'standing') {
    return standing === null ? null : { byKind: standing.byKind, capped: standing.capped };
  }
  if (counts === null) return null;
  const c = tab === 'deleted' ? counts.deleted : counts.reversed;
  return { byKind: c.byKind, capped: c.capped };
}

/**
 * The Filter menu's kinds: each with its count where the count is exact (a floor or a figure still
 * being prepared isn't a count a filter can promise, so it is left off, never guessed).
 */
export function kindOptions(
  counted: { byKind: Readonly<Record<RecordKind, number>>; capped: boolean } | null,
  pending: boolean,
): Array<{ id: RecordKind; label: string; count?: number }> {
  const exact = counted !== null && !counted.capped && !pending;
  return KIND_ORDER.map((kind) => ({
    id: kind,
    label: KIND_WORDS[kind].many.replace(/^./, (c) => c.toUpperCase()),
    ...(exact ? { count: counted.byKind[kind] } : {}),
  }));
}

/**
 * Whether the person page's *On the record* row shows: any list with items, a floor, or the record
 * still being prepared (`settledEmpty`'s rule) — never left out on a guess.
 */
export function recordRowShows(
  standing: StandingCount,
  /** `'failed'`: the read failed — never drawn as nothing (the row stands, and says so). */
  presence: RecordPresence | 'failed' | null,
  pending: boolean,
): boolean {
  if (pending) return true;
  if (!settledEmpty({ count: standing.total, capped: standing.capped, pending: false }))
    return true;
  if (presence === 'failed') return true;
  if (presence === null) return false;
  return presence.pending.length > 0 || presence.deleted || presence.reversed;
}

/** "2 reports · 1 comment": each kind with any, in order; a floor's figures are floors. */
export function kindsLine(byKind: Readonly<Record<RecordKind, number>>, capped: boolean): string {
  return KIND_ORDER.filter((k) => byKind[k] > 0)
    .map((k) => kindCount(k, byKind[k], capped))
    .join(' · ');
}

// ── The item ─────────────────────────────────────────────────────────────────────────────────

export type BadgeView = { label: string; tone: 'dim' | 'out' | 'lit' };

/** A by-line: who, the verb and its moment, and what follows (a reason, a note). */
export type ByLine = {
  at: number;
  who: RecordPerson | RecordSubject | null;
  /** "Hid it Sat 10 Oct 19:48". */
  did: string;
  reason: string | null;
  note: string | null;
};

export type Plate =
  | {
      kind: 'words';
      heading: string;
      kicker: string;
      display: string | null;
      text: Title | null;
    }
  | { kind: 'erased'; heading: string; title: string; sub: string };

export type LifeStationView = {
  when: string;
  title: string;
  sub?: string;
  mark: 'dot' | 'hollow' | 'ring' | 'square' | 'warn' | 'now' | 'end';
  next?: 'thin' | 'heavy' | 'dashed';
  lasted?: string;
};

export type ItemView = {
  target: Target;
  kicker: string;
  badges: BadgeView[];
  reason: string | null;
  byLines: ByLine[];
  decisionsCapped: boolean;
  plate: Plate;
  life: { stations: LifeStationView[]; ifLabel: string | null } | null;
  /** What the lever would do (*If overturned*, *If kept*), as label-and-words rows. */
  would: { title: string; rows: Array<{ label: string; text: string }> } | null;
  lever: Lever | null;
  /**
   * When an overturn would leave its words erased, as the server read it (`eraseAtIfReleased`):
   * a day, at once (the 30 days are already past), or not while something else holds it (its
   * Post's decision, an open flag). `null` when no overturn is offered.
   */
  erasure: Erasure | null;
  /** What a restore brings back with it, or brought back (a Report's comments and thumbs). */
  comesBack: { title: string; rows: Array<{ label: string; text: string }> } | null;
  /** The place a receipt names: the body, or a comment's Report. */
  place: string | null;
};

/**
 * When an overturn would leave the words erased: a day, at once, held by something else — or never
 * again, because they already were (an erased comment's shell, whose decision can still come off).
 */
export type Erasure =
  | { kind: 'on'; day: string; days: number | null }
  | { kind: 'atOnce'; days: number | null }
  | { kind: 'held' }
  | { kind: 'erased' }
  /** No deletion time on record to count from (a Post its Reports' deletions withdrew, an old alert). */
  | { kind: 'unrecorded' };

/**
 * The server's `eraseAtIfReleased` in words. The server's clock is the later of thirty days after
 * the deletion and the moment the query ran — a moment after this minute-old `now`, so a date past
 * the thirty days is that moment: at once, as is any date not ahead of `now`. `null` with an
 * overturn on offer means something else — its Post's decision, an open flag — would still hold it;
 * or, with no deletion time on record to count from, that no date is recorded.
 */
export function erasureOf(
  at: number | null,
  deletedAt: number | null,
  now: number,
  tz?: string,
): Erasure {
  if (at === null) return deletedAt === null ? { kind: 'unrecorded' } : { kind: 'held' };
  const days = deletedAt === null ? null : daysBetween(deletedAt, Math.max(at, now));
  const due = at <= now || (deletedAt !== null && at > deletedAt + WITHDRAWN_ERASE_MS);
  return due ? { kind: 'atOnce', days } : { kind: 'on', day: dayWords(at, now, tz), days };
}

/** "Sun 25 Oct · 30 days after Rob deleted it", "At once", or held: the *If overturned* row. */
export function erasureWords(e: Erasure, author: string): string {
  switch (e.kind) {
    case 'on':
      return e.days === null ? e.day : W.erasedWhen(e.day, e.days, author);
    case 'atOnce':
      return e.days === null ? W.atOnce : W.erasedWhen(W.atOnce, e.days, author);
    case 'held':
      return W.erasedHeld;
    case 'erased':
      return W.wordsErased;
    case 'unrecorded':
      return W.notRecorded;
  }
}

/** Whether the item is up for skaters now, by its document. */
const isUp = (published: ItemRead['published']): boolean =>
  published !== null &&
  (published as unknown as { moderationStatus?: unknown }).moderationStatus === 'visible';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** How long a state lasted, written out: "6 days", "5 hours", "Under an hour". */
export function spanWords(ms: number): string {
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY);
    return `${d} ${d === 1 ? 'day' : 'days'}`;
  }
  if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR);
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  return 'Under an hour';
}

/** Whole days between two instants, for "30 days after Rob deleted it". */
const daysBetween = (from: number, to: number): number => Math.round((to - from) / DAY);

export function itemView(
  item: ItemRead,
  subject: RecordSubject,
  now: number,
  tz?: string,
): ItemView {
  const kind = item.targetType;
  const words = KIND_WORDS[kind];
  const content = item.content;
  const decisions = [...item.decisions].sort((a, b) => b.at - a.at);
  const standing = decisions.find((d) => d.standing) ?? null;
  const newest = decisions[0] ?? null;
  const deletedAt = item.authorDeletedAt;
  const kept = standing !== null && keptAfter(standing.at, deletedAt);
  const author = firstOf(subject);
  const withdrawnBadge: BadgeView = {
    label: kind === 'accessAlert' ? W.badge.retractedBy(author) : W.badge.deletedBy(author),
    tone: 'out',
  };
  const ended = standing === null && newest !== null ? newest.endedHow : null;

  // ── The decision note: its badges, the reason it stands on, who did what ──
  const badges: BadgeView[] = [];
  if (standing !== null) {
    if (kept) badges.push(withdrawnBadge, { label: W.badge.kept, tone: 'dim' });
    else {
      badges.push({ label: W.badge[standing.kind], tone: 'dim' });
      if (deletedAt !== null) badges.push(withdrawnBadge);
    }
  } else {
    if (ended === 'restore') badges.push({ label: W.badge.restored, tone: 'lit' });
    if (ended === 'undo') badges.push({ label: W.badge.undone, tone: 'lit' });
    if (ended === 'overturn') badges.push({ label: W.badge.overturned, tone: 'out' });
    if (deletedAt !== null) badges.push(withdrawnBadge);
  }
  if (item.erasedAt !== null) badges.push({ label: W.badge.erased, tone: 'out' });

  const headline = standing ?? (ended === 'overturn' ? newest : null);
  const byLines: ByLine[] = [];
  for (const d of decisions) {
    const isKept = keptAfter(d.at, deletedAt);
    byLines.push({
      at: d.at,
      who: d.decidedBy,
      did: `${isKept ? W.did.kept : W.did[d.kind]} ${momentWords(d.at, now, tz)}`,
      reason: d === headline ? null : d.reason,
      note: null,
    });
    if (d.endedAt !== null && d.endedHow !== null && d.endedHow !== 'superseded') {
      byLines.push({
        at: d.endedAt,
        who: d.endedBy,
        did: `${W.did[d.endedHow]} ${momentWords(d.endedAt, now, tz)}`,
        reason: d.endedReason,
        note: null,
      });
    }
  }
  if (deletedAt !== null) {
    byLines.push({
      at: deletedAt,
      who: subject,
      did: `${kind === 'accessAlert' ? W.did.authorRetracted : W.did.deleted} ${momentWords(deletedAt, now, tz)}`,
      reason: null,
      note:
        standing !== null && !kept
          ? W.keptWhileStands
          : decisions.length === 0 && item.eraseAt !== null
            ? W.erasedUnlessKept(momentWords(item.eraseAt, now, tz))
            : null,
    });
  }
  byLines.sort((a, b) => a.at - b.at);

  // ── The plate ──
  const where = whereParts(kind, item);
  const place = placeName(kind, item);
  const up = isUp(item.published);
  const plate: Plate =
    content === null
      ? {
          kind: 'erased',
          heading: kind === 'comment' ? W.asWritten : W.asPublished,
          title:
            item.erasedAt === null
              ? W.erasedPlateNoDate
              : W.erasedPlate(dayWords(item.erasedAt, now, tz)),
          sub:
            item.erasedAt !== null && deletedAt !== null
              ? W.erasedAfter(daysBetween(deletedAt, item.erasedAt), author)
              : W.erasedStays,
        }
      : {
          kind: 'words',
          heading:
            up && standing === null && place !== null && (ended === 'restore' || ended === 'undo')
              ? W.onAgain(place)
              : kind === 'comment'
                ? W.asWritten
                : kind === 'accessAlert'
                  ? W.asSkatersSaw
                  : W.asPublished,
          kicker: [...where, momentWords(content.at, now, tz)].join(' · '),
          display:
            kind === 'post'
              ? (content.title ?? null)
              : kind === 'hazard' && content.title
                ? hazardTypeLabel(content.title as HazardType)
                : kind === 'accessAlert' && content.title
                  ? alertReason(content.title)
                  : null,
          text: content.text?.trim()
            ? { text: content.text.trim(), quoted: true, gone: false }
            : null,
        };

  // ── The lever, and what it would do ──
  const lever = leverOf(item.can);
  // An erased comment's shell can still have its decision overturned; its words are already gone,
  // so there is no erasure ahead to say (the server sends no date for it either).
  const erasure: Erasure | null =
    lever?.ok === true && lever.action === 'overturn'
      ? content === null
        ? { kind: 'erased' }
        : erasureOf(item.eraseAtIfReleased, deletedAt, now, tz)
      : null;
  let would: ItemView['would'] = null;
  if (lever?.ok === true && lever.action === 'overturn') {
    would = {
      title: W.ifOverturned,
      rows: [
        { label: W.record, text: W.comesOff(author) },
        { label: words.head, text: W.staysDeleted },
        ...(erasure !== null ? [{ label: W.erased, text: erasureWords(erasure, author) }] : []),
      ],
    };
  }
  if (lever?.ok === true && lever.action === 'keep') {
    would = {
      title: W.ifKept,
      rows: [
        { label: W.record, text: W.goesOn(author) },
        { label: words.head, text: W.keptUntilOverturned },
      ],
    };
  }

  const seasonAt = content?.at ?? decisions.at(-1)?.at ?? null;
  return {
    target: { targetType: kind, targetId: item.targetId },
    kicker:
      seasonAt === null
        ? words.head
        : `${words.head} · ${W.season(seasonYears(seasonOf(seasonAt)))}`,
    badges,
    reason: headline?.reason ?? null,
    byLines,
    decisionsCapped: item.decisionsCapped,
    plate,
    life: lifeOf({
      item,
      kind,
      content,
      decisions,
      standing,
      place,
      lever,
      erasure,
      subject,
      now,
      tz,
    }),
    would,
    lever,
    erasure,
    comesBack: comesBackOf(item, lever, standing, ended, deletedAt),
    place,
  };
}

/**
 * *Comes back with it* (8.7) on a Report a restore would bring back, *Came back with it* (8.8) on
 * one restored and up: its comments still up and its thumbs, counted (a floor past the cap, never
 * a zero for not knowing).
 */
function comesBackOf(
  item: ItemRead,
  lever: Lever | null,
  standing: Decision | null,
  ended: Decision['endedHow'],
  deletedAt: number | null,
): ItemView['comesBack'] {
  const back = item.comesBack;
  if (back === null) return null;
  const restoring = standing !== null && lever?.ok === true && lever.action === 'restore';
  const restored =
    standing === null && deletedAt === null && (ended === 'restore' || ended === 'undo');
  if (!restoring && !restored) return null;
  const counted = (c: Counted, one: string, many: string) =>
    c.count === 0 && !c.capped ? W.noneOf : countedWords(c, one, many);
  return {
    title: restoring ? W.comesBack : W.cameBack,
    rows: [
      { label: W.backComments, text: counted(back.comments, 'comment', 'comments') },
      { label: W.backThumbs, text: counted(back.ratings, 'thumb', 'thumbs') },
    ],
  };
}

type Counted = { count: number; capped: boolean };

/** "1 comment", "3 thumbs", "50+ comments" — a floor's plural is always the many form. */
const countedWords = (c: Counted, one: string, many: string): string =>
  `${floorText(c)} ${c.count === 1 && !c.capped ? one : many}`;

/** One event in an item's life, and the state it left the item in. */
type LifeEvent = {
  at: number;
  title: string;
  sub?: string;
  mark: LifeStationView['mark'];
  after: 'up' | 'down';
};

/** "Sun 4 Oct": a station's day. */
const dayWords = (at: number, now: number, tz?: string) =>
  momentWords(at, now, tz).replace(/ \d\d:\d\d$/, '');
/** "14:52": a moment's time. */
const timeOf = (at: number, now: number, tz?: string) =>
  /\d\d:\d\d$/.exec(momentWords(at, now, tz))?.[0] ?? '';

/**
 * **Its life** (8.7): a station per event, oldest first — posted, each decision and how it ended,
 * the author's deletion, the erasure — the line between two the state it was in (visible to
 * skaters, or out of sight) and how long; then today, and what the lever would do (dashed). A record
 * of what happened to the post, never a word about the ice.
 */
function lifeOf(args: {
  item: ItemRead;
  kind: RecordKind;
  content: RecordContent | null;
  decisions: Decision[];
  standing: Decision | null;
  place: string | null;
  lever: Lever | null;
  erasure: Erasure | null;
  subject: RecordSubject;
  now: number;
  tz?: string;
}): ItemView['life'] {
  const { item, kind, content, standing, place, lever, erasure, subject, now, tz } = args;
  const author = firstOf(subject);
  const deletedAt = item.authorDeletedAt;
  // A record of decisions: an item nobody decided on, or whose words are gone, has no life drawn.
  if (args.decisions.length === 0 || content === null) return null;
  const events: LifeEvent[] = [];
  const created = (item.published as unknown as { _creationTime?: unknown } | null)?._creationTime;
  events.push({
    // When it was posted — the document's own birth; a report's skate time can come after a hide.
    at: typeof created === 'number' ? created : content.at,
    title: W.posted,
    ...(place !== null ? { sub: kind === 'comment' ? `On ${place}` : place } : {}),
    mark: 'dot',
    after: 'up',
  });
  for (const d of [...args.decisions].sort((a, b) => a.at - b.at)) {
    const isKept = keptAfter(d.at, deletedAt);
    events.push({
      at: d.at,
      title: isKept ? W.badge.kept : W.badge[d.kind],
      ...(nameOf(d.decidedBy) !== null ? { sub: W.byWhom(firstOf(d.decidedBy)) } : {}),
      mark: 'hollow',
      after: 'down',
    });
    if (d.endedAt !== null && d.endedHow !== null && d.endedHow !== 'superseded') {
      events.push({
        at: d.endedAt,
        title:
          d.endedHow === 'overturn'
            ? W.badge.overturned
            : d.endedHow === 'undo'
              ? W.badge.undone
              : W.badge.restored,
        ...(nameOf(d.endedBy) !== null ? { sub: W.byWhom(firstOf(d.endedBy)) } : {}),
        mark: 'square',
        after: d.endedHow === 'overturn' ? 'down' : 'up',
      });
    }
  }
  if (deletedAt !== null) {
    events.push({
      at: deletedAt,
      title: kind === 'accessAlert' ? W.badge.retractedBy(author) : W.badge.deletedBy(author),
      ...(standing !== null && !keptAfter(standing.at, deletedAt) ? { sub: W.keptAsEvidence } : {}),
      mark: 'warn',
      after: 'down',
    });
  }
  events.sort((a, b) => a.at - b.at);
  // A state can't be "up" after the author took it back, whatever order the rows landed in.
  if (deletedAt !== null) {
    for (const e of events) if (e.at >= deletedAt && e.after === 'up') e.after = 'down';
  }

  const stations: LifeStationView[] = events.map((e, i) => {
    const next = events[i + 1];
    return {
      when: dayWords(e.at, now, tz),
      title: e.title,
      ...(e.sub !== undefined ? { sub: e.sub } : {}),
      mark: e.mark,
      ...(next !== undefined
        ? { next: e.after === 'up' ? 'heavy' : 'thin', lasted: spanWords(next.at - e.at) }
        : {}),
    };
  });

  const last = events.at(-1) as LifeEvent;
  const lastStation = stations.at(-1) as LifeStationView;
  let now_: LifeStationView;
  if (dateWords(last.at, now, tz) === dateWords(now, now, tz)) {
    // Its last event was today: that station is today, with its time (8.8's restore).
    lastStation.mark = 'now';
    lastStation.when = `${dateWords(now, now, tz)} · ${timeOf(last.at, now, tz)}`;
    now_ = lastStation;
  } else {
    // Today: the state it is in, and how long it has been out of sight.
    lastStation.next = last.after === 'up' ? 'heavy' : 'thin';
    lastStation.lasted = spanWords(now - last.at);
    const downSince = [...events].reverse().find((e, i, all) => {
      const before = all[i + 1];
      return e.after === 'down' && (before === undefined || before.after !== 'down');
    });
    now_ = {
      when: W.today(dateWords(now, now, tz)),
      title:
        standing !== null
          ? deletedAt !== null
            ? W.onTheRecord
            : W.stillDown[standing.kind]
          : deletedAt !== null
            ? W.deletedNow
            : last.after === 'up'
              ? W.upNow
              : W.stillDown.hidden,
      ...(last.after === 'down' && downSince !== undefined
        ? { sub: W.outOfSightFor(spanWords(now - downSince.at)) }
        : {}),
      mark: 'now',
    };
    stations.push(now_);
  }
  let ifLabel: string | null = null;
  const ahead = lever?.ok === true ? lever.action : null;
  const station =
    ahead === null ? null : ifStation(ahead, { place, content, erasure, author, now, tz });
  if (station !== null) {
    now_.next = 'dashed';
    delete now_.lasted;
    stations.push(station);
    ifLabel = station.when;
  }
  return { stations, ifLabel };
}

/** What the lever would do, as the life strip's last, dashed station. */
function ifStation(
  action: RecordAction,
  o: {
    place: string | null;
    content: RecordContent | null;
    erasure: Erasure | null;
    author: string;
    now: number;
    tz?: string;
  },
): LifeStationView | null {
  switch (action) {
    case 'restore':
      return {
        when: W.ifRestored,
        title: o.place === null ? W.backUp : W.backOn(o.place),
        ...(o.content !== null ? { sub: W.datedThen(dateWords(o.content.at, o.now, o.tz)) } : {}),
        mark: 'end',
      };
    case 'overturn':
      switch (o.erasure?.kind) {
        case 'on':
          return {
            when: W.ifOverturned,
            title: W.erasedThen(o.erasure.day),
            ...(o.erasure.days !== null && {
              sub: W.daysAfterDeleted(o.erasure.days, o.author),
            }),
            mark: 'end',
          };
        case 'atOnce':
          return { when: W.ifOverturned, title: W.erasedAtOnce, mark: 'end' };
        case 'erased':
          return {
            when: W.ifOverturned,
            title: W.comesOff(o.author),
            sub: W.wordsErased,
            mark: 'end',
          };
        case 'unrecorded':
          return { when: W.ifOverturned, title: W.comesOff(o.author), mark: 'end' };
        default:
          return {
            when: W.ifOverturned,
            title: W.comesOff(o.author),
            sub: W.erasedHeld,
            mark: 'end',
          };
      }
    case 'keep':
      return { when: W.ifKept, title: W.onRecordUntilOverturned, mark: 'end' };
    case 'hideAgain':
      // The boards draw no station for a hide again: the restore is today's.
      return null;
  }
}

// ── The receipts ─────────────────────────────────────────────────────────────────────────────

export type RecordWrite =
  | { kind: 'restore'; withReportIds?: string[] }
  | { kind: 'hideAgain'; reason: string }
  | { kind: 'overturn'; reason?: string }
  | { kind: 'keep'; reason: string };

/** What the undo toast says of a write, from the operator's side. */
export function receiptWords(
  write: RecordWrite,
  about: {
    kind: RecordKind;
    place: string | null;
    subject: RecordSubject;
    /** A Report's comments and thumbs, as the pane read them before the restore. */
    comesBack?: ItemRead['comesBack'];
  },
  result: { eraseAt?: number | null },
  now: number,
  tz?: string,
): { title: string; description?: string } {
  const word = KIND_WORDS[about.kind].one;
  const name = subjectName(about.subject);
  switch (write.kind) {
    case 'restore': {
      const n = write.withReportIds?.length ?? 0;
      const back = about.comesBack ? cameBackWords(about.comesBack) : null;
      return {
        title: about.place === null ? W.backUpReceipt(word) : W.backOnPlace(word, about.place),
        ...(n > 0 ? { description: W.withReports(n) } : back !== null ? { description: back } : {}),
      };
    }
    case 'hideAgain':
      return { title: W.hiddenAgainReceipt(word) };
    case 'overturn':
      return {
        title: W.offRecordReceipt(name),
        // When it's erased, only with the server's date: an open flag can still hold it.
        description: W.staysDeletedReceipt(
          word,
          result.eraseAt == null ? null : dateWords(result.eraseAt, now, tz),
        ),
      };
    case 'keep':
      return { title: W.keptReceipt(word, name), description: W.keptReceiptBody };
  }
}

/** "Its 1 comment and 2 thumbs came back with it" — only what there was; nothing for none. */
function cameBackWords(back: NonNullable<ItemRead['comesBack']>): string | null {
  const parts = [
    back.comments.count > 0 || back.comments.capped
      ? countedWords(back.comments, 'comment', 'comments')
      : null,
    back.ratings.count > 0 || back.ratings.capped
      ? countedWords(back.ratings, 'thumb', 'thumbs')
      : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : W.cameBackReceipt(parts.join(' and '));
}

// ── The Post's chooser ───────────────────────────────────────────────────────────────────────

export type ChooserMember = {
  reportId: string;
  title: string;
  sub: Line;
  choosable: boolean;
};

/** The chooser's rows (8.9 *A post*): what each Report is and why it's down; nothing pre-chosen. */
export function chooserMembers(choices: ChoicesRead, now: number, tz?: string): ChooserMember[] {
  return choices.members.map((m) => {
    const title = [m.waterBodyName, dayWords(m.skateEndTime, now, tz)]
      .filter((p): p is string => p !== null)
      .join(' · ');
    if (m.standing === 'author_deleted') {
      return {
        reportId: m.reportId,
        title,
        sub: {
          text: W.memberDeleted(
            m.authorDeletedAt === null ? null : dateWords(m.authorDeletedAt, now, tz),
          ),
        },
        choosable: false,
      };
    }
    if (m.standing === 'visible' || m.standing === 'returns') {
      return {
        reportId: m.reportId,
        title,
        sub: { text: m.standing === 'visible' ? W.memberUp : W.memberReturns },
        choosable: false,
      };
    }
    const down = m.down;
    const by = down?.by == null ? W.someone : firstName(down.by.displayName || down.by.username);
    const verb = down === undefined ? W.downOther : (W.downVerb[down.action] ?? W.downOther);
    return {
      reportId: m.reportId,
      title,
      sub:
        down === undefined
          ? { text: verb }
          : { text: `${W.downBy(verb, by)} · ${W.reason}: `, quote: down.reason },
      choosable: true,
    };
  });
}
