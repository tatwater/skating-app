import type { InboxLane, InboxListLane } from '@skating/core';

import { shortAge } from '@/lib/ages';

import { dayMonth } from '../../shell/consoleTime';
import {
  AUTO_CHIP,
  andMore,
  askedBy,
  byAuthor,
  catalogChip,
  DECISION_WORDS,
  DOWN_CHIP,
  DRAWN_CHIP,
  disputesChip,
  FILED_BY_APP,
  FROM_REPORT,
  FROM_SKATE,
  flaggedBy,
  GONE_CHIP,
  LANE_LABELS,
  lookalikeChip,
  NO_CANDIDATE,
  occurrence,
  overlapChip,
  REASON_CHIP,
  reportsChip,
  requestChip,
  SOMEONE,
  TARGET_CHIP,
  TARGET_TITLE,
  TICKET_CHIP,
  UNTITLED,
  WITHDRAWN_CHIP,
  WITHDRAWN_SUB,
} from '../words/inboxWords';
import type { InboxRowView } from './inboxTypes';

/**
 * **Rows → what the Inbox list draws** (boards 2.1–2.9, the middle column), pure, so each rule is
 * tested without a page:
 *
 * - **A row** is its chips (what it is: the reason or kind first, then what the item adds), a title
 *   (the content's words, the body, the ask), a sub-line (where, who wrote it, who filed it) and a
 *   short age on the right ("4 d"). Every fact is the server's, resolved at read; nothing is
 *   invented and nothing judged — a row never calls ice anything (D3).
 * - **A decided row** (a lane's *Decided this week*, the Decided lane) leads with its decision's chip
 *   and names who decided it; its age counts from the decision.
 * - **All open** reads every lane in the flow-through order, and the list draws each lane's boundary
 *   where the lane changes ({@link flowEntries}).
 */

export type ChipTone = 'default' | 'bad' | 'warn' | 'dim';
export type RowChip = { label: string; tone: ChipTone };

export type RowView = {
  id: string;
  lane: InboxLane;
  chips: RowChip[];
  title: string;
  sub: string | null;
  age: string;
  /** Decided: drawn quieter, opened read-only. */
  done: boolean;
  /** What type-ahead matches. */
  name: string;
  /** Its content was withdrawn by its author: drawn in the quiet ink, never as live content. */
  withdrawn: boolean;
};

const ACRE_SQM = 4046.8564224;
const MILE_M = 1609.344;

/** "41 ac", "1,650 ac" — an area as the boards write it. */
export function acres(sqm: number): string {
  const ac = sqm / ACRE_SQM;
  return `${(ac < 10 ? Math.round(ac * 10) / 10 : Math.round(ac)).toLocaleString('en-US')} ac`;
}

/** "0.4 mi", "12 mi" — a distance as the boards write it (a tenth under ten miles). */
export function miles(meters: number): string {
  const mi = meters / MILE_M;
  return `${(mi < 10 ? Math.round(mi * 10) / 10 : Math.round(mi)).toLocaleString('en-US')} mi`;
}

/** A share (0–1) as a whole percent, held to 0–100. */
export function percent(share: number): number {
  return Math.max(0, Math.min(100, Math.round(share * 100)));
}

/**
 * A row's age, short ("4 d", "5 h"): from the decision for a decided row, else from the oldest open
 * filing. Never negative (a clock skew reads "0 min").
 */
export function rowAge(row: Pick<InboxRowView, 'filedAt' | 'decided'>, now: number): string {
  return shortAge(now - (row.decided?.at ?? row.filedAt));
}

const join = (...parts: (string | null | undefined | false)[]): string | null => {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p !== '');
  return kept.length === 0 ? null : kept.join(' · ');
};

const quoted = (text: string | null | undefined) =>
  text == null || text.trim() === '' ? null : `“${text.trim()}”`;

/** The open row's own chips, title and sub-line, by kind. */
function openFacts(
  row: InboxRowView,
): Pick<RowView, 'chips' | 'title' | 'sub'> & { withdrawn?: boolean } {
  const where = row.body?.name ?? null;
  switch (row.kind) {
    case 'flag': {
      const reason = row.reasons[0];
      const chips: RowChip[] = [];
      if (reason !== undefined) {
        chips.push({
          label: REASON_CHIP[reason],
          tone: reason === 'unsafe_false_report' && row.decided === null ? 'bad' : 'default',
        });
      }
      chips.push({ label: TARGET_CHIP[row.target.targetType], tone: 'default' });
      // Withdrawn by its author (deleted, or since erased): not up, whatever its status says — the
      // handlers' "Withdrawn on …" family, never drawn as live content.
      const withdrawn = row.target.exists && row.target.withdrawn;
      if (!row.target.exists) chips.push({ label: GONE_CHIP, tone: 'dim' });
      else if (withdrawn) chips.push({ label: WITHDRAWN_CHIP, tone: 'dim' });
      else if (
        row.target.moderationStatus === 'hidden' ||
        row.target.moderationStatus === 'removed'
      ) {
        chips.push({ label: DOWN_CHIP[row.target.moderationStatus], tone: 'dim' });
      }
      if (row.autoFiled) chips.push({ label: AUTO_CHIP, tone: 'default' });
      const title =
        row.target.exists && row.target.summary.trim() !== ''
          ? row.target.summary
          : TARGET_TITLE[row.target.targetType];
      const filer = row.autoFiled
        ? join(FILED_BY_APP, row.occurrences > 1 && occurrence(row.occurrences))
        : row.firstFiler === null
          ? null
          : flaggedBy(
              andMore(row.firstFiler.displayName, row.memberCount - 1, row.memberCountIsFloor),
            );
      return {
        chips,
        title,
        sub: join(
          withdrawn && WITHDRAWN_SUB,
          where,
          row.author !== null && byAuthor(row.author.displayName),
          filer,
        ),
        withdrawn,
      };
    }
    case 'access':
      return {
        chips: [
          ...(row.disputes === null
            ? []
            : [{ label: disputesChip(dayMonth(row.disputes.ruledAt)), tone: 'bad' as const }]),
          { label: reportsChip(row.reporters, row.memberCountIsFloor), tone: 'default' },
        ],
        title: row.body?.name ?? UNTITLED,
        sub: join(row.body?.place, quoted(row.latestNote)),
      };
    case 'request': {
      const chips: RowChip[] = [];
      if (row.requestKind === 'admit') {
        if (row.candidate !== null) {
          chips.push({ label: catalogChip(acres(row.candidate.areaSqM)), tone: 'default' });
        } else if (row.resolveError !== null) {
          chips.push({ label: NO_CANDIDATE, tone: 'warn' });
        }
      }
      chips.push({ label: requestChip(row.requestKind), tone: 'default' });
      return {
        chips,
        title: row.body?.name ?? row.candidate?.name ?? UNTITLED,
        sub: join(
          row.body?.place,
          row.resolveError === null
            ? askedBy(row.askers, row.memberCountIsFloor)
            : row.resolveError,
          row.resolveError === null && quoted(row.note),
        ),
      };
    }
    case 'place':
      return {
        chips: [
          ...(row.lookalikeMeters === null
            ? []
            : [{ label: lookalikeChip(miles(row.lookalikeMeters)), tone: 'warn' as const }]),
          { label: requestChip(row.placeKind), tone: 'default' },
        ],
        title: join(quoted(row.name), where) ?? UNTITLED,
        sub: join(
          row.fromReport ? FROM_REPORT : askedBy(row.askers, row.memberCountIsFloor),
          row.firstAsker !== null &&
            andMore(row.firstAsker.displayName, row.askers - 1, row.memberCountIsFloor),
        ),
      };
    case 'drawn':
      return {
        chips: [
          { label: DRAWN_CHIP, tone: 'default' },
          ...(row.overlapShare === null
            ? []
            : [{ label: overlapChip(percent(row.overlapShare)), tone: 'default' as const }]),
        ],
        title: row.overName === null ? (row.body?.name ?? UNTITLED) : drawnOver(row.overName),
        sub: join(row.fromSkate && FROM_SKATE, row.drawer?.displayName),
      };
    case 'ticket':
      return {
        chips: [{ label: TICKET_CHIP[row.category], tone: 'default' }],
        title: row.snippet.trim() === '' ? UNTITLED : row.snippet,
        sub: row.person?.displayName ?? null,
      };
  }
}

/** "User-drawn body over Caspian Lake" (the board's). */
export const drawnOver = (name: string) => `User-drawn body over ${name}`;

/** A row as the list draws it. */
export function rowView(row: InboxRowView, now: number): RowView {
  const facts = openFacts(row);
  const decided = row.decided;
  if (decided === null) {
    return {
      id: row.itemId,
      lane: row.lane,
      chips: facts.chips,
      title: facts.title,
      sub: facts.sub,
      age: rowAge(row, now),
      done: false,
      name: facts.title.replace(/^[“"]/, ''),
      withdrawn: facts.withdrawn === true,
    };
  }
  // A decided row: its decision leads; the sub-line says where (and, for content, whose), then who
  // decided it — the boards' "Mascoma Lake · by Rob Tremblay · Matt …".
  const who = decided.by?.displayName ?? SOMEONE;
  const whose =
    row.kind === 'flag' && row.author !== null ? byAuthor(row.author.displayName) : null;
  return {
    id: row.itemId,
    lane: row.lane,
    chips: [
      ...facts.chips.slice(0, 1).map((c) => ({ ...c, tone: 'default' as const })),
      { label: DECISION_WORDS[decided.decision], tone: 'default' },
    ],
    title: facts.title,
    sub: join(row.body?.name, whose, who),
    age: rowAge(row, now),
    done: true,
    name: facts.title.replace(/^[“"]/, ''),
    withdrawn: facts.withdrawn === true,
  };
}

// ── All open's flow-through ──────────────────────────────────────────────────────────────────

export type FlowEntry =
  | { type: 'boundary'; lane: InboxLane; label: string }
  | { type: 'row'; row: RowView; index: number };

/**
 * The list's entries in order: the rows, each numbered for the listbox, and — for All open — each
 * lane's boundary where the lane changes (the first included, so every row sits under its lane's
 * name). A lane's own list has no boundaries. Rows keep the server's order; nothing is re-sorted.
 */
export function flowEntries(rows: readonly RowView[], lane: InboxListLane): FlowEntry[] {
  const out: FlowEntry[] = [];
  let last: InboxLane | null = null;
  rows.forEach((row, index) => {
    if (lane === 'all' && row.lane !== last) {
      out.push({ type: 'boundary', lane: row.lane, label: LANE_LABELS[row.lane] });
    }
    last = row.lane;
    out.push({ type: 'row', row, index });
  });
  return out;
}

/** Today's decided rows (the zero list's *Decided today*): decided since `since`, newest first. */
export function decidedSince(rows: readonly InboxRowView[], since: number): InboxRowView[] {
  return rows
    .filter((r) => r.decided !== null && r.decided.at >= since)
    .sort((a, b) => (b.decided?.at ?? 0) - (a.decided?.at ?? 0));
}
