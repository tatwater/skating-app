import {
  AROUND_IT_LINE_PHRASES,
  AROUND_IT_PHRASE_KEYS,
  type AroundItPhrase,
  type ObservedFrom,
  zonedInstantOnDayOf,
} from '@skating/core';
import {
  dayKey,
  dayLabel,
  inchesFigure,
  measuredMeanCm,
  milesWords,
  readingCm,
  skateTimes,
} from '../handlers/Flag/flagFormat';
import type {
  AroundItData as AroundItView,
  AroundReportData as AroundReportView,
} from '../handlers/Flag/flagTypes';
import { AROUND_WORDS as W } from '../handlers/Flag/flagWords';

/**
 * ***Around it*, as words and rows** (board 2.1's line, its drawer) — pure. The line's summary is
 * built **only** from the server's phrases (core's `aroundItPhrases` keys), each the reports' own
 * claim counted ("2 measured less · 1 saw open water"), never a class like "thin" or "safe" (D3,
 * the founder's call of 2026-11-20). A phrase the server didn't send is never invented here.
 */

/** The phrases in the line's order, each counted at least once, the first `max` of them. */
export function linePhrases(
  phrases: readonly AroundItPhrase[],
  max: number = AROUND_IT_LINE_PHRASES,
): AroundItPhrase[] {
  const order = (k: AroundItPhrase['key']) => AROUND_IT_PHRASE_KEYS.indexOf(k);
  return phrases
    .filter((p) => order(p.key) >= 0 && Number.isInteger(p.count) && p.count > 0)
    .slice()
    .sort((a, b) => order(a.key) - order(b.key))
    .slice(0, Math.max(0, max));
}

/** The line's gray second line: "2 measured less · 1 saw open water"; `null` with nothing to say. */
export function aroundSummary(
  phrases: readonly AroundItPhrase[],
  max: number = AROUND_IT_LINE_PHRASES,
): string | null {
  const shown = linePhrases(phrases, max);
  if (shown.length === 0) return null;
  return shown.map((p) => W.phrase[p.key](p.count)).join(' · ');
}

/** The line's first line: how many more reports, at which body, within how many days. */
export function aroundLine(view: AroundItView, bodyName: string): string {
  const n = view.reports.length;
  return n === 0
    ? W.lineNone(bodyName, view.window.days)
    : W.line(n, bodyName, view.window.days, isCapped(view));
}

/** The read stopped short on either side: every count of the window's reports is a floor. */
export const isCapped = (view: Pick<AroundItView, 'cappedBefore' | 'cappedAfter'>): boolean =>
  view.cappedBefore || view.cappedAfter;

/** The window's reports, this one included, as a count that says when it is a floor ("101+"). */
export const reportsCount = (view: AroundItView): string =>
  `${view.reports.length + 1}${isCapped(view) ? '+' : ''}`;

// ── The drawer ─────────────────────────────────────────────────────────────────────────────────

/** One row of the drawer: a report, the flagged one marked. */
export type AroundRow = {
  report: AroundReportView;
  isThis: boolean;
  time: string;
  vantage: string | null;
  distance: string | null;
  /** Staff read hidden ones too: marked. */
  down: 'hidden' | 'removed' | null;
};

/** A day in the drawer: its reports, newest first — or a run of days with none. */
export type AroundDay =
  | { kind: 'day'; key: string; label: string; rows: AroundRow[] }
  | {
      kind: 'none';
      key: string;
      label: string;
      /** The run's first and last calendar days ("2026-10-12"), oldest first. */
      span: [string, string];
    };

export const VANTAGE_WORDS: Record<ObservedFrom, string> = {
  on_ice: 'on the ice',
  shore: 'from shore',
  secondhand: 'secondhand',
};

/** Noon, as a minute of the day: the walk's anchor in each calendar day. */
const NOON = 12 * 60;
/** The most days a window spans (±7 days and a margin): the walk's bound. */
const MAX_WINDOW_DAYS = 31;

function rowOf(report: AroundReportView, isThis: boolean, timeZone?: string): AroundRow {
  const status = report.moderationStatus;
  return {
    report,
    isThis,
    time: skateTimes(report.skateStartTime, report.skateEndTime, timeZone),
    vantage: report.observedFrom === null ? null : VANTAGE_WORDS[report.observedFrom],
    distance: isThis || report.distanceMeters === null ? null : milesWords(report.distanceMeters),
    down: status === 'hidden' || status === 'removed' ? status : null,
  };
}

/** Every report in the window — this one included — newest first. */
export function newestFirst(view: AroundItView): { report: AroundReportView; isThis: boolean }[] {
  const all = [
    ...view.reports.map((report) => ({ report, isThis: false })),
    { report: view.flagged, isThis: true },
  ];
  return all.sort((a, b) => b.report.skateEndTime - a.report.skateEndTime);
}

/**
 * The drawer's days, newest first: each day that holds a report, and each run of days between (or
 * after the newest, up to the window's end) that holds none, as one quiet line ("Mon 12 – Tue 13 Oct
 * · no reports"). Days are the reader's calendar days.
 */
export function aroundDays(view: AroundItView, timeZone?: string): AroundDay[] {
  const rows = newestFirst(view).map(({ report, isThis }) => rowOf(report, isThis, timeZone));
  const byDay = new Map<string, AroundRow[]>();
  for (const row of rows) {
    const key = dayKey(row.report.skateEndTime, timeZone);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  // Walk the window's calendar days in the reader's zone, newest first, each at its local noon
  // (core's zoned helper): stepping 24 h from an instant skips or repeats a day across a DST change.
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const firstKey = dayKey(view.window.from, zone);
  const walked: (AroundDay & { sortKey: string })[] = [];
  let gap: { first: number; last: number } | null = null;
  const flush = () => {
    if (gap === null) return;
    const label =
      dayKey(gap.first, zone) === dayKey(gap.last, zone)
        ? dayLabel(gap.first, zone)
        : `${dayLabel(gap.first, zone)} – ${dayLabel(gap.last, zone)}`;
    const key = dayKey(gap.last, zone);
    walked.push({
      kind: 'none',
      key: `none-${dayKey(gap.first, zone)}`,
      label,
      span: [dayKey(gap.first, zone), key],
      sortKey: key,
    });
    gap = null;
  };
  const seen = new Set<string>();
  for (let back = 0; back <= MAX_WINDOW_DAYS; back++) {
    const t = zonedInstantOnDayOf(view.window.to, NOON, zone, -back);
    const key = dayKey(t, zone);
    if (key < firstKey) break;
    seen.add(key);
    const dayRows = byDay.get(key);
    if (dayRows === undefined) {
      gap = gap === null ? { first: t, last: t } : { first: t, last: gap.last };
      continue;
    }
    flush();
    walked.push({ kind: 'day', key, label: dayLabel(t, zone), rows: dayRows, sortKey: key });
  }
  flush();
  // A report outside the walked window (a clock edge) is still listed, never dropped — in its place.
  for (const [key, dayRows] of byDay) {
    const first = dayRows[0];
    if (!seen.has(key) && first !== undefined) {
      walked.push({
        kind: 'day',
        key,
        label: dayLabel(first.report.skateEndTime, zone),
        rows: dayRows,
        sortKey: key,
      });
    }
  }
  return walked
    .sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0))
    .map(({ sortKey: _, ...day }) => day as AroundDay);
}

/** The drawer's four stats: reports (this one included), on the ice, from shore, measured range. */
export function aroundStats(view: AroundItView): {
  reports: number;
  onIce: number;
  shore: number;
  secondhand: number;
  /** "1.8–3.5", "3.5", or `null` when no report measured. */
  measured: string | null;
} {
  const all = [view.flagged, ...view.reports];
  const cms = all.flatMap((r) =>
    (r.claims.iceThickness?.readings ?? [])
      .filter((x) => x.method === 'measured')
      .map(readingCm)
      .filter((c): c is number => c !== null),
  );
  const lo = cms.length === 0 ? null : Math.min(...cms);
  const hi = cms.length === 0 ? null : Math.max(...cms);
  const measured =
    lo === null || hi === null
      ? null
      : inchesFigure(lo) === inchesFigure(hi)
        ? inchesFigure(lo)
        : `${inchesFigure(lo)}–${inchesFigure(hi)}`;
  return {
    reports: all.length,
    onIce: all.filter((r) => r.observedFrom === 'on_ice').length,
    shore: all.filter((r) => r.observedFrom === 'shore').length,
    secondhand: all.filter((r) => r.observedFrom === 'secondhand').length,
    measured,
  };
}

/** The window's span on one line: "7–13 Oct", or "28 Sep – 4 Oct" across a month. */
export function windowSpan(view: AroundItView, timeZone?: string): string {
  const from = dayLabel(view.window.from, timeZone).split(' ').slice(1);
  const to = dayLabel(view.window.to, timeZone).split(' ').slice(1);
  if (from[1] === to[1]) return `${from[0]}–${to[0]} ${to[1]}`;
  return `${from.join(' ')} – ${to.join(' ')}`;
}

/** Whether a report's own measured mean exists (for the claim chip's emphasis). */
export const hasMeasured = (r: AroundReportView): boolean =>
  measuredMeanCm(r.claims.iceThickness) !== null;
