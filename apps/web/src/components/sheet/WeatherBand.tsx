import {
  conditionsFromWindowHour,
  hourAt,
  type SunTimes,
  type WindowHour,
  weatherCells,
  weatherRunSummary,
} from '@skating/core';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { ConditionIcon } from '../weatherGlyphs';
import { Eyebrow } from './SheetPanel';
import type { SectionProps } from './sectionProps';
import { WeatherCorrection } from './WeatherCorrection';

/**
 * The weather band under the timeline (A10-6, founder call 2026-09-23): one card per archived hour
 * the skate touched, in the drawer's own hourly lockup — symbol, temperature, amount, wind — placed
 * under the ruler at the hour it belongs to, and a line for what the weather did over the skate.
 * *Correct it* opens the same correction the phone has; a correction stores as the author's own
 * reading (`source: 'user'`).
 *
 * Nothing here is a safety claim (D3 / D150): what the weather did, never what the ice is.
 */
export function WeatherBand({
  hours,
  windowHours,
  endMs,
  timeZone,
  sun,
  fractionOf,
  report,
  dispatch,
  dim = false,
}: {
  hours: WindowHour[] | null;
  windowHours: readonly WindowHour[];
  endMs: number | undefined;
  timeZone: string;
  sun: SunTimes | null;
  /** The timeline's x for an instant, 0…1 — the cards sit under their hours. */
  fractionOf: (ms: number) => number;
  dim?: boolean;
} & Pick<SectionProps, 'report' | 'dispatch'>) {
  const [correcting, setCorrecting] = useState(false);
  const cells = weatherCells(windowHours, timeZone, sun);
  const summary = weatherRunSummary(cells);
  const corrected = report.sheet.scalars.conditions;
  const at = hours && endMs !== undefined ? hourAt(hours, endMs) : null;
  const HOUR = 3600_000;

  if (endMs === undefined) {
    return (
      <div className={cn('flex h-10 items-center px-4', dim && 'sheet-dim')}>
        <Eyebrow>Weather</Eyebrow>
        <span className="ml-3 text-foreground-muted text-xs">
          Set when you got off and the hours you were out fill in here.
        </span>
      </div>
    );
  }
  if (hours === null || summary === null) {
    return (
      <div className={cn('flex h-10 items-center px-4', dim && 'sheet-dim')}>
        <Eyebrow>Weather</Eyebrow>
        <span className="ml-3 text-foreground-muted text-xs">
          {hours === null ? 'Reading the archive…' : 'No archived weather for these hours yet.'}
        </span>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col', dim && 'sheet-dim')}>
      <ul className="relative mx-9 h-[92px] list-none p-0">
        {cells.map((cell) => {
          const left = fractionOf(cell.startMs) * 100;
          const right = fractionOf(cell.startMs + HOUR) * 100;
          return (
            <li
              key={cell.startMs}
              className="absolute top-1 flex h-[84px] min-w-14 flex-col items-center justify-center gap-0.5 border-border border-y border-l px-1 last:border-r"
              style={{ left: `${left}%`, width: `${Math.max(right - left, 4)}%` }}
              aria-label={`${cell.label}, ${cell.conditionLabel}, ${cell.temperatureF}°F${
                cell.windMph !== undefined
                  ? `, wind ${cell.windFrom ?? ''} ${cell.windMph} mph`
                  : ''
              }${cell.amount ? `, ${cell.amount}` : ''}`}
            >
              <span className="font-mono text-[10px] text-foreground-muted">{cell.label}</span>
              <ConditionIcon glyph={cell.glyph} label={cell.conditionLabel} size="text-sm" />
              <span className="text-foreground text-sm tabular-nums">{cell.temperatureF}°</span>
              <span className="h-3 font-mono text-[10px] text-foreground-muted leading-3 tabular-nums">
                {cell.amount ?? ''}
              </span>
              <span className="font-mono text-[10px] text-foreground-muted tabular-nums">
                {cell.windMph !== undefined ? `${cell.windFrom ?? ''} ${cell.windMph}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex h-8 items-center gap-3 border-border border-t px-4 font-mono text-[10.5px]">
        <span className="text-foreground-muted uppercase tracking-[0.1em]">While you skated</span>
        <span className="text-foreground text-[11px]">{summary.temperature}</span>
        {summary.wind ? <span className="text-foreground text-[11px]">{summary.wind}</span> : null}
        <span className="text-foreground text-[11px]">{summary.sky}</span>
        {corrected !== undefined && corrected.source !== 'openmeteo' ? (
          <span className="text-foreground-muted">· corrected</span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          className="text-foreground-muted hover:text-foreground hover:underline"
          onClick={() => setCorrecting((c) => !c)}
        >
          {correcting ? 'Close' : 'Not what you saw? Correct it'}
        </button>
      </div>
      {correcting ? (
        <div className="border-border border-t px-4 py-3">
          <WeatherCorrection
            initial={
              corrected ??
              (at ? { ...conditionsFromWindowHour(at), source: 'user' } : { source: 'user' })
            }
            onChange={(next) => dispatch({ type: 'setScalar', key: 'conditions', value: next })}
            onDone={() => setCorrecting(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
