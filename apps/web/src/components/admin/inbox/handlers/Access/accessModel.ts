import { TRUST_CLASS_LABELS, waterBodyClassLabel } from '@skating/core';

import { acresText } from '../../../bodies/bodiesModel';
import { dayMonth } from '../../../shell/consoleTime';
import type { InboxItemView } from '../../list/inboxTypes';
import { ACCESS_WORDS as W } from './accessWords';

/**
 * **Board 2.2, as data** — pure, so every rule is tested without a page: an `access` item (the open
 * `no_public_access` reports on one body, the standing ruling if there is one, and the reports that
 * ruling dismissed) turned into what the handler draws: the head's badge, the body's line, the three
 * stats, the timeline of claims and the ruling, the two *If* blocks, and which buttons the bar draws.
 *
 * - **A ruling says *accessible***, never *open* (the stored verdict is `open`; the board's rule).
 * - **A button is drawn only where the item's `can` allows it** (`null`); a sentence is the
 *   server's refusal, and the button is not drawn (D217).
 * - Nothing here says anything about the ice (D3): a ruling is about who may reach the water.
 */

/** The item behind 2.2. */
export type AccessItem = Extract<InboxItemView, { kind: 'access' }>;
export type AccessReport = AccessItem['reports'][number];
export type AccessRuling = NonNullable<AccessItem['ruling']>;
export type AccessVerdict = AccessRuling['verdict'];
type Person = NonNullable<AccessReport['filer']>;
type PersonRef = NonNullable<AccessRuling['by']>;

const DAY = 86_400_000;

/** A verdict as the console says it. */
export function verdictWords(v: AccessVerdict): string {
  return v === 'open' ? W.ruledAccessible : W.ruledNoAccess;
}

// ── The head ─────────────────────────────────────────────────────────────────────────────────

/**
 * The head's badge: reports after a standing *accessible* ruling dispute it (red, the board's);
 * after a *no public access* ruling they don't dispute it — they came after it (gray). None before
 * any ruling.
 */
export function headBadge(item: AccessItem): { text: string; tone: 'bad' | 'default' } | null {
  if (item.ruling === null) return null;
  return item.ruling.verdict === 'open'
    ? { text: W.disputes, tone: 'bad' }
    : { text: W.afterNoAccess, tone: 'default' };
}

/** The body's line over its name: "Reservoir · Troy, NY · 1,650 ac". */
export function bodyKicker(body: AccessItem['body']): string {
  const parts = [waterBodyClassLabel(body.type)];
  if (body.place !== null) parts.push(body.place);
  if (body.areaSqM !== null) parts.push(`${acresText(body.areaSqM)} ac`);
  return parts.join(' · ');
}

// ── The stats ────────────────────────────────────────────────────────────────────────────────

export type AccessStat = {
  id: 'noAccess' | 'contest' | 'ruling';
  label: string;
  value: string;
  unit?: string;
  tone?: 'bad';
  sub?: string;
};

/** Distinct reporters among the open reports (one open flag per flagger, so it is the count). */
export function reporterCount(item: AccessItem): number {
  const people = new Set(
    item.reports.map((r) => (r.filer === null ? `flag:${r.flagId}` : `person:${r.filer.userId}`)),
  );
  return people.size;
}

/** Whole days between two instants, never negative. */
export function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / DAY));
}

/**
 * The stats over the timeline: who says there is no access, who asks for it back, and the ruling.
 *
 * The board's middle stat, *Say accessible*, is drawn from the only stored "accessible" claims: the
 * open **contest-access asks** (`contestAsks`), which a skater can file only while the body stands
 * under a no-public-access ruling — so it is drawn only then, worded as what it counts. Under an
 * accessible ruling, or none, nobody can have filed one, and a "0" there would read as a finding.
 */
export function accessStats(item: AccessItem, now: number): AccessStat[] {
  const n = reporterCount(item);
  const say: AccessStat = {
    id: 'noAccess',
    label: W.sayNoAccess,
    value: String(n),
    unit: n === 1 ? W.skater : W.skaters,
    // Red only while they dispute an accessible ruling: the board's red is the disagreement.
    ...(item.ruling?.verdict === 'open' ? { tone: 'bad' as const } : {}),
    ...(item.ruling !== null ? { sub: W.sinceRuling } : {}),
  };
  const r = item.ruling;
  const contest: AccessStat[] =
    r?.verdict === 'none'
      ? [
          {
            id: 'contest',
            label: W.askAccessible,
            value: `${item.contestAsks.count.toLocaleString('en-US')}${item.contestAsks.capped ? '+' : ''}`,
            unit: item.contestAsks.count === 1 && !item.contestAsks.capped ? W.skater : W.skaters,
            sub: W.contestingIt,
          },
        ]
      : [];
  if (r === null) {
    return [say, { id: 'ruling', label: W.ruling, value: W.noRulingYet, sub: W.firstReports }];
  }
  const days = daysBetween(r.ruledAt, now);
  return [
    say,
    ...contest,
    {
      id: 'ruling',
      label: verdictWords(r.verdict),
      value: String(days),
      unit: days === 1 ? W.dayAgo : W.daysAgo,
      sub: `${W.by} ${r.by?.displayName ?? W.someoneGone}`,
    },
  ];
}

// ── The timeline ─────────────────────────────────────────────────────────────────────────────

export type TimelineEvent =
  | {
      kind: 'report';
      key: string;
      at: number;
      filer: Person | null;
      autoFiled: boolean;
      note: string | null;
    }
  | {
      kind: 'ruling';
      key: 'ruling';
      at: number;
      verdict: AccessVerdict;
      by: PersonRef | null;
      note: string | null;
      /** What the ruler cited (staff-facing); the board's *Source* line. */
      reason: string | null;
    }
  | {
      kind: 'dismissed';
      key: 'dismissed';
      at: number;
      filers: Person[];
      notes: string[];
      count: number;
    };

/**
 * The claims and the ruling, newest first: each open report, the standing ruling, and the reports
 * that ruling dismissed as one event dated by the latest of them. Ties keep that order.
 */
export function accessTimeline(item: AccessItem): TimelineEvent[] {
  const events: TimelineEvent[] = item.reports.map((r) => ({
    kind: 'report',
    key: `report:${r.flagId}`,
    at: r.filedAt,
    filer: r.filer,
    autoFiled: r.autoFiled,
    note: r.note,
  }));
  if (item.ruling !== null) {
    events.push({
      kind: 'ruling',
      key: 'ruling',
      at: item.ruling.ruledAt,
      verdict: item.ruling.verdict,
      by: item.ruling.by,
      note: item.ruling.note,
      reason: item.ruling.reason?.trim() || null,
    });
  }
  const dismissed = item.dismissedByRuling;
  if (dismissed.length > 0) {
    events.push({
      kind: 'dismissed',
      key: 'dismissed',
      at: Math.max(...dismissed.map((d) => d.filedAt)),
      filers: dismissed.flatMap((d) => (d.filer === null ? [] : [d.filer])),
      // One quote per distinct note: two reporters saying the same words read once.
      notes: [...new Set(dismissed.flatMap((d) => (d.note === null ? [] : [d.note.trim()])))],
      count: dismissed.length,
    });
  }
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.at - a.e.at || a.i - b.i)
    .map(({ e }) => e);
}

/** A person's standing on their byline: "Trusted · 22 pts"; a departed person has none. */
export function standingLine(p: Person): string | null {
  if (p.trustClass === null) return null;
  return `${TRUST_CLASS_LABELS[p.trustClass]} · ${p.points.toLocaleString('en-US')} ${W.pts}`;
}

// ── The two futures ──────────────────────────────────────────────────────────────────────────

export type IfRow = { label: string; value: string };

/** "Both closed", "The report closed", "All 3 closed" — the reports a ruling would close. */
function reportsClosed(n: number): string {
  const which = n === 1 ? 'The report' : n === 2 ? 'Both' : `All ${n}`;
  return `${which} ${W.closed} · ${n === 1 ? 'the reporter told' : W.reportersTold}`;
}

/**
 * *If no public access* and *If confirmed accessible*: what each ruling does to the body, the
 * reports and the standing ruling — the board's rows, said for whichever ruling stands now.
 */
export function ifBlocks(
  item: AccessItem,
  timeZone?: string,
): { noAccess: IfRow[]; accessible: IfRow[] } {
  const r = item.ruling;
  const n = item.reports.length;
  const ruling = (to: AccessVerdict) =>
    r === null
      ? W.newRuling
      : r.verdict === to
        ? W.reDatedToday
        : W.replaces(dayMonth(r.ruledAt, timeZone));
  return {
    noAccess: [
      { label: W.body, value: r?.verdict === 'none' ? W.unchanged : W.dimmedOffMap },
      { label: W.reports, value: reportsClosed(n) },
      { label: W.ruling, value: ruling('none') },
      { label: W.reason, value: W.askedWhenChosen },
    ],
    accessible: [
      { label: W.body, value: r?.verdict === 'none' ? W.backOnMap : W.unchanged },
      {
        label: W.reports,
        value: `${W.dismissed} · ${n === 1 ? 'the reporter told' : W.reportersTold}`,
      },
      { label: W.ruling, value: ruling('open') },
    ],
  };
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────

/** The writes the bar may send: a verdict, or `null` to clear the standing one. */
export type AccessAct = 'none' | 'open' | 'clear';

export type AccessBar = {
  /** *No public access* (N): asks its reason first. */
  noAccess: boolean;
  /** *Confirm accessible* (C). */
  accessible: boolean;
  /** *Clear the … ruling*, and its words; `null` when not drawn. */
  clear: string | null;
};

/**
 * Which buttons the bar draws: each only where the item's `can` answers `null` (allowed). A verb
 * the item doesn't answer is not drawn either. Clearing is worded for the ruling it clears.
 */
export function accessBar(item: AccessItem): AccessBar {
  const allowed = (v: keyof AccessItem['can']) => item.can[v] === null;
  return {
    noAccess: allowed('ruleClosed'),
    accessible: allowed('ruleAccessible'),
    clear:
      allowed('clearRuling') && item.ruling !== null
        ? item.ruling.verdict === 'none'
          ? W.clearNoAccess
          : W.clearAccessible
        : null,
  };
}

/** Whether the bar draws anything at all (a viewer whose `can` refuses every verb sees none). */
export function hasBar(bar: AccessBar): boolean {
  return bar.noAccess || bar.accessible || bar.clear !== null;
}

/**
 * A receipt's second line: what the ruling did to the reports, from the server's own count. A
 * ruling either way closes every open report (each reporter hears the verdict); **a clear closes
 * none** — the question is open again, the reports stay, and the item stays in its lane.
 */
export function receiptDetail(act: AccessAct, flagsClosed: number): string {
  if (act === 'clear') return W.reportsStayOpen;
  // None closed (the reports were withdrawn meanwhile): nobody was told, and the line says so.
  if (flagsClosed <= 0) return act === 'none' ? W.noneToClose : W.noneToDismiss;
  const verb = act === 'none' ? W.closedPast : W.dismissedPast;
  if (flagsClosed === 1) return `1 report ${verb} · ${W.reporterTold}`;
  return `${flagsClosed.toLocaleString('en-US')} reports ${verb} · ${W.reportersTold}`;
}

/** A receipt's words for what landed. */
export function receiptTitle(act: AccessAct): string {
  return act === 'none' ? W.receiptNone : act === 'open' ? W.receiptOpen : W.receiptClear;
}
