import { formatDurationLabel, MERGE_SUGGEST_SHARE, TRUST_CLASS_LABELS } from '@skating/core';

import { ageInWords } from '@/lib/ages';

import type { InboxItemView } from '../../list/inboxTypes';
import { dayTime, skateSpan } from '../Flag/flagFormat';
import { DRAWN_WORDS as W } from './drawnWords';

/**
 * **Board 2.5, as data** — pure, so every rule is tested without a page: a `drawn` item (a body a
 * skater drew, the body it overlaps if any, who drew it, the report it came from) turned into what
 * the handler draws: the head's line, the gauge's words, the report rows, the merge block, and which
 * levers the bar draws.
 *
 * - **A lever is drawn only where the item's `can` holds its verb**: `null` draws it; a sentence is
 *   the server's refusal and draws nothing (D217); a verb absent draws nothing.
 * - **Merge is drawn as *Coming soon*** where `can.mergeDrawn` allows it (D286): the next slice
 *   builds the write, so the lever is the kit's unavailable face, never a working button.
 * - **The gauge's figure and whether it suggests a merge are the server's** (`overlap.share`,
 *   `overlap.suggested`); nothing here re-decides either.
 */

export type DrawnItem = Extract<InboxItemView, { kind: 'drawn' }>;
type Lockup = NonNullable<DrawnItem['drawer']>;

/** The verbs a drawn item's bar draws, as the item's `can` allows them. */
export type DrawnBar = {
  /** *Merge into ‹body›*: drawn, saying *Coming soon* — `null` when not drawn. */
  merge: string | null;
  approve: boolean;
  reject: boolean;
};

/** The bar the item's `can` allows: a verb whose answer is `null`, and nothing else. */
export function drawnBar(item: Pick<DrawnItem, 'can' | 'overlap'>): DrawnBar {
  const allowed = (v: 'approveDrawn' | 'rejectDrawn' | 'mergeDrawn') =>
    v in item.can && item.can[v] === null;
  return {
    merge: allowed('mergeDrawn') && item.overlap !== null ? item.overlap.body.name : null,
    approve: allowed('approveDrawn'),
    reject: allowed('rejectDrawn'),
  };
}

export const hasBar = (bar: DrawnBar): boolean => bar.merge !== null || bar.approve || bar.reject;

/**
 * The first refusal among the verbs the item draws, when it draws no lever at all — said once in the
 * body, so an empty bar is never a mystery. `null` when any lever is drawn or none is refused.
 */
export function refusalSaid(item: Pick<DrawnItem, 'can' | 'overlap' | 'decided'>): string | null {
  if (item.decided !== null || hasBar(drawnBar(item))) return null;
  for (const v of ['approveDrawn', 'rejectDrawn', 'mergeDrawn'] as const) {
    const answer = item.can[v];
    if (typeof answer === 'string') return answer;
  }
  return null;
}

/** The head's micro line: where the drawing came from, then its age written out. */
export function headLine(item: Pick<DrawnItem, 'fromReport' | 'filedAt'>, now: number): string {
  const from = item.fromReport !== null ? W.fromSkate : W.drawnByASkater;
  return `${from} · ${ageInWords(item.filedAt, now)}`;
}

/** The threshold as a whole percent, from core (*Merge suggested from 80 %*). */
export const MERGE_PERCENT = Math.round(MERGE_SUGGEST_SHARE * 100);

/** A drawer's standing: "Trusted · 41 pts", or nothing for a departed drawer. */
export function trustLine(p: Lockup | null): string {
  if (p === null || p.deleted || p.trustClass === null) return W.noTrust;
  return `${TRUST_CLASS_LABELS[p.trustClass]} · ${p.points.toLocaleString('en-US')} ${W.pts}`;
}

/**
 * The drawer's standing and their visible reports, as the board's *Trust* row: "Trusted · 41 pts ·
 * 14 reports". A count the server couldn't give (`null`) adds nothing; a departed drawer has none.
 */
export function standingLine(p: Lockup | null, reports: number | null): string {
  const trust = trustLine(p);
  if (p === null || p.deleted || p.trustClass === null || reports === null) return trust;
  return `${trust} · ${W.reports(reports)}`;
}

/**
 * The skate the drawing came from: its moving time, then when — "1h 36m · 11 Oct 09:00–11:00".
 * The provider's moving time leaves out stops, so it is never the span's length; with none sent,
 * only when. A skate with no end reads from its start.
 */
export function skateLine(skate: NonNullable<DrawnItem['skate']>, timeZone?: string): string {
  const when =
    skate.endTime !== null
      ? skateSpan(skate.startTime, skate.endTime, timeZone)
      : dayTime(skate.startTime, timeZone);
  return skate.elapsedSeconds !== null && skate.elapsedSeconds > 0
    ? `${formatDurationLabel(skate.elapsedSeconds / 60)} · ${when}`
    : when;
}

/** What a merge would do, said as the merge — the block never offers to do it here. */
export function mergeRows(survivor: string): { label: string; value: string }[] {
  return [
    { label: W.rowReport, value: W.mergeReport },
    { label: W.rowDrawing, value: W.mergePoints(survivor) },
  ];
}
