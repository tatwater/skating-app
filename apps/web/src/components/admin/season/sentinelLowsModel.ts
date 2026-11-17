/**
 * The Overview Home's sentinel row as it is drawn (B01-2b): `sentinelLows.forSeason`'s answer turned
 * into the chart's and the matrix's rows, in °F.
 *
 * **Dates are labels, never instants.** The server sends the watch's own calendar days (`YYYY-MM-DD`,
 * cut in the site's zone when the night was stored); every date here is built from those strings with
 * the watch's own `addDaysIso`, and every label from `dayLabel`, which reads the string in UTC — so a
 * night reads the same date in every reader's zone and across both DST changes. Nothing here makes a
 * `Date` in the reader's zone.
 *
 * **A gap is a gap.** A night with no stored low is `null`: a break in its line and an empty cell,
 * never zero and never interpolated. The two marked nights come only from what the season record
 * stored, never inferred from the lows.
 */

import type { api } from '@skating/convex/api';
import { addDaysIso, celsiusToFahrenheit } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';

import { dayLabel } from '@/components/admin/metrics/metricsModel';
import { type Loadable, readState } from '@/components/admin/reads/consoleReads';
import {
  endLabelWords,
  imageryLineWords,
  imageryNightWords,
  periodWords,
  sentinelShortName,
  watchLineWords,
  watchOpenedWords,
} from './sentinelWords';

export type SentinelLowsRead = FunctionReturnType<typeof api.sentinelLows.forSeason>;
type Valued = Extract<SentinelLowsRead, { state: 'value' }>;

/** A low in whole °F, as the board writes it: `−0` is `0`. */
export function wholeF(c: number): number {
  const f = Math.round(celsiusToFahrenheit(c));
  return f === 0 ? 0 : f;
}

/** The ink each sentinel's line wears, in roster order — the board's white, `g6`, `g5`. */
export type LowsTone = 'lead' | 'muted' | 'faint';
const TONES: readonly LowsTone[] = ['lead', 'muted', 'faint'];

export type LowsRow = {
  key: string;
  /** The board's short name, or the roster's full name. */
  label: string;
  /** The roster's full name. */
  name: string;
  tone: LowsTone;
  /** One whole-°F low a night; `null` is a gap. */
  values: Array<number | null>;
  /** The end label ("Kinsman 37", or "Kinsman 37 · 10 Oct" when its last low is an earlier night). */
  end: { text: string; value: number; index: number } | null;
};

/** A marked night: where its rule goes, its words, and the rows it puts a marker on. */
export type LowsEvent = {
  night: string;
  index: number;
  words: string;
  /** The rows (by index) whose low that night the record named, with their low. */
  marks: Array<{ row: number; value: number }>;
};

export type LowsView = {
  nights: string[];
  /** Each night's label ("1 Oct"). */
  labels: string[];
  /** "1–12 Oct". */
  period: string;
  rows: LowsRow[];
  lines: { watchF: number; imageryF: number; watchWords: string; imageryWords: string };
  opened: LowsEvent | null;
  imagery: LowsEvent | null;
  /** The y axis: every 10 °F from below the coldest to above the warmest, lines included. */
  ticks: number[];
  /** The x axis' labeled nights (by index): the first, every few, and the last. */
  labeled: number[];
};

/** The nights from `first` to `last`, inclusive — `addDaysIso`, the watch's own day step. */
export function nightsOf(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

/** The y ticks: a step of 10 °F from the one at or below the lowest value to the one at or above the highest. */
export function tensAround(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  let lo = Math.floor(Math.min(...values) / 10) * 10;
  let hi = Math.ceil(Math.max(...values) / 10) * 10;
  if (lo === hi) [lo, hi] = [lo - 10, hi + 10];
  const out: number[] = [];
  for (let v = lo; v <= hi; v += 10) out.push(v);
  return out;
}

/**
 * The nights the x axis labels: the first, then every `step` (about four labels whatever the
 * length), then the last — a label too close to the last is dropped. The board labels 1, 5, 9 and
 * 12 Oct over twelve nights.
 */
export function labeledNights(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const last = count - 1;
  const step = Math.max(1, Math.ceil(last / 3));
  const out: number[] = [];
  for (let i = 0; i <= last - Math.ceil(step / 2); i += step) out.push(i);
  out.push(last);
  return out;
}

type Marked = { on: string; sites: ReadonlyArray<{ bodyId: string | null; name: string }> };

function eventOf(
  record: Marked | null,
  nights: readonly string[],
  rows: readonly LowsRow[],
  bodyIds: ReadonlyArray<string | null>,
  names: readonly string[],
  words: string,
): LowsEvent | null {
  if (record === null) return null;
  const index = nights.indexOf(record.on);
  if (index === -1) return null;
  const marks: LowsEvent['marks'] = [];
  rows.forEach((row, r) => {
    const named = record.sites.some((s) =>
      s.bodyId !== null ? s.bodyId === bodyIds[r] : s.name === names[r],
    );
    const value = row.values[index];
    if (named && value != null) marks.push({ row: r, value });
  });
  return { night: record.on, index, words, marks };
}

/** The row's view of a read that has lows. */
export function lowsView(read: Valued): LowsView {
  const nights = nightsOf(read.firstDate, read.lastDate);
  const rows: LowsRow[] = read.sentinels.map((s, i) => {
    const label = sentinelShortName(s.name);
    const values = nights.map((_, n) => {
      const c = s.lows[n];
      return c == null ? null : wholeF(c);
    });
    let last = -1;
    values.forEach((v, n) => {
      if (v !== null) last = n;
    });
    const value = last === -1 ? null : (values[last] as number);
    return {
      key: s.key,
      label,
      name: s.name,
      tone: TONES[Math.min(i, TONES.length - 1)] as LowsTone,
      values,
      end:
        value === null
          ? null
          : {
              text: endLabelWords(
                label,
                value,
                last === nights.length - 1 ? null : (nights[last] as string),
              ),
              value,
              index: last,
            },
    };
  });
  const watchF = wholeF(read.lines.watchC);
  const imageryF = wholeF(read.lines.imageryC);
  const bodyIds = read.sentinels.map((s) => s.bodyId);
  const names = read.sentinels.map((s) => s.name);
  const all = rows.flatMap((r) => r.values.filter((v): v is number => v !== null));
  const coldest =
    read.imageryLine === null || read.imageryLine.sites.length === 0
      ? null
      : wholeF(Math.min(...read.imageryLine.sites.map((s) => s.lowC)));
  return {
    nights,
    labels: nights.map(dayLabel),
    period: periodWords(read.firstDate, read.lastDate),
    rows,
    lines: {
      watchF,
      imageryF,
      watchWords: watchLineWords(watchF),
      imageryWords: imageryLineWords(imageryF),
    },
    opened: eventOf(
      read.opened,
      nights,
      rows,
      bodyIds,
      names,
      watchOpenedWords(read.opened?.sites.length ?? 0, read.opened?.of ?? 0),
    ),
    imagery: eventOf(read.imageryLine, nights, rows, bodyIds, names, imageryNightWords(coldest)),
    ticks: tensAround([...all, watchF, imageryF]),
    labeled: labeledNights(nights.length),
  };
}

/** What the row draws: on its way, failed, before the floor, nothing stored, or the lows. */
export type LowsState =
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void; pending: boolean }
  | { kind: 'before'; countsFrom: string }
  | { kind: 'none' }
  | { kind: 'value'; view: LowsView };

/**
 * The read's four answers, never folded (`readState`): on its way, failed (with Try again), nothing
 * recorded — before the floor, or after it with nothing stored — and the lows.
 */
export function lowsState(value: Loadable<SentinelLowsRead | null>): LowsState {
  const state = readState(value);
  switch (state.kind) {
    case 'loading':
      return { kind: 'loading' };
    case 'failed':
      return { kind: 'failed', retry: state.failure.retry, pending: state.failure.pending };
    case 'none':
      return { kind: 'none' };
    case 'value': {
      const read = state.value;
      if (read.state === 'before') return { kind: 'before', countsFrom: read.countsFrom };
      if (read.state === 'none') return { kind: 'none' };
      return { kind: 'value', view: lowsView(read) };
    }
  }
}
