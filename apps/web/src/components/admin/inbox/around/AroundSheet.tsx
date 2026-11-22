import { AROUND_IT_DAYS } from '@skating/core';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { RetryNote } from '@/components/kit/retry-note';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/kit/sheet';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { ComingSoonLink } from '@/components/kit/unavailable-button';
import { cn } from '@/lib/utils';

import { claimChips } from '../handlers/Flag/flagModel';
import { AROUND_WORDS as W } from '../handlers/Flag/flagWords';
import { ClaimChips, type Retry } from '../handlers/Flag/parts';
import type { AroundState } from './AroundLine';
import {
  type AroundDay,
  type AroundRow,
  aroundDays,
  aroundStats,
  reportsCount,
  windowSpan,
} from './aroundModel';

export type AroundSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AroundState;
  bodyName: string;
  /** How far either side of the flagged report, in days (1, 3 or 7). */
  days: number;
  onDays: (days: number) => void;
  /** The flagged report is in the Safety lane: its measured claim is marked as on the board. */
  safety?: boolean;
  timeZone?: string;
};

/**
 * ***Reports around this one*** (board 2.1 `?around=1`): every report at this body within ±1, 3 or 7
 * days of the flagged one, **newest first and this one among them** — marked by its left rule and a
 * *This report* badge where a distance would stand — so the read isn't limited to the ones that
 * agree. A sheet over the whole console (its scrim covers the rail and the status bar), Close with
 * Esc in its head, a ruled foot at its end. Each row's *Open in Reports →* sits in its bottom-right
 * corner on hover or focus, Coming soon (D286); a report staff can read but skaters can't is marked;
 * a window the read had to cut short says so.
 */
export function AroundSheet({
  open,
  onOpenChange,
  state,
  bodyName,
  days,
  onDays,
  safety = false,
  timeZone,
  onRetry,
  retrying = false,
}: AroundSheetProps & Retry) {
  const view = typeof state === 'object' && state !== null ? state : null;
  const stats = view === null ? null : aroundStats(view);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="drawer" data-slot="around-sheet">
        <SheetHeader>
          <SheetTitle>{W.sheetTitle}</SheetTitle>
          <SheetDescription data-slot="around-span">
            {view === null ? bodyName : `${bodyName} · ${windowSpan(view, timeZone)}`}
          </SheetDescription>
          <span className="flex flex-1 justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" data-slot="around-days" aria-label={W.windowLabel}>
                    {W.window(days)}
                    <DropdownMenuCaret />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                {AROUND_IT_DAYS.map((d) => (
                  <DropdownMenuItem
                    key={d}
                    data-days={d}
                    aria-current={d === days ? 'true' : undefined}
                    onClick={() => onDays(d)}
                  >
                    {W.window(d)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </SheetHeader>
        {stats !== null && (
          <StatGrid
            columns={4}
            ruled={false}
            data-slot="around-stats"
            className="shrink-0 border-0 border-b border-solid border-line px-gutter py-(--space-4)"
          >
            <StatTile
              key="reports"
              label={W.statReports}
              value={view === null ? stats.reports : reportsCount(view)}
              unit={W.inclThis}
            />
            <StatTile key="ice" label={W.onIce} value={stats.onIce} />
            <StatTile
              key="shore"
              label={W.fromShore}
              value={stats.shore}
              {...(stats.secondhand > 0 && {
                sub: `${stats.secondhand} ${W.secondhand.toLowerCase()}`,
              })}
            />
            <StatTile
              key="measured"
              label={W.measured}
              value={stats.measured ?? W.measuredNone}
              {...(stats.measured !== null && { unit: 'in' })}
              {...(stats.measured === null && { tone: 'dim' as const })}
            />
          </StatGrid>
        )}
        <SheetBody className="gap-0 px-0 pt-0" data-slot="around-list">
          <RetryNote
            data-slot="around-sheet-failed"
            className="px-gutter pt-(--space-4)"
            onRetry={onRetry}
            pending={retrying}
          >
            {state === 'failed' ? W.missing : undefined}
          </RetryNote>
          {view === null ? (
            state === 'failed' ? null : (
              <p className="m-0 px-gutter pt-(--space-4) text-row text-fg3">
                {state === 'loading' ? W.loading : W.sheetMissing}
              </p>
            )
          ) : (
            aroundDays(view, timeZone).map((day) => (
              <DayGroup key={day.key} day={day} safety={safety} />
            ))
          )}
        </SheetBody>
        <SheetFooter
          note={
            <span className="flex flex-col gap-(--space-1) leading-list">
              <span>{W.foot}</span>
              {view?.cappedBefore === true && (
                <span data-slot="around-capped">{W.cappedBefore}</span>
              )}
              {view?.cappedAfter === true && <span data-slot="around-capped">{W.cappedAfter}</span>}
            </span>
          }
        >
          {stats !== null && (
            <ComingSoonLink data-slot="around-open-all">
              {W.openAll(view === null ? String(stats.reports) : reportsCount(view))}
            </ComingSoonLink>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DayGroup({ day, safety }: { day: AroundDay; safety: boolean }) {
  const head = (
    <div
      data-slot="around-day"
      data-none={day.kind === 'none' ? '' : undefined}
      className="flex items-center gap-(--space-2_5) px-gutter pt-(--space-3_5) pb-(--space-1_5)"
    >
      <span
        className={cn(
          'text-kick leading-none font-semibold tracking-kick whitespace-nowrap uppercase',
          day.kind === 'none' ? 'text-fg-disabled' : 'text-fg3',
        )}
      >
        {day.kind === 'none' ? `${day.label} · ${W.noReports}` : day.label}
      </span>
      <i
        aria-hidden="true"
        className="flex-1 border-0 border-t-(length:--stroke-hair) border-dotted border-line"
      />
    </div>
  );
  if (day.kind === 'none') return head;
  return (
    <>
      {head}
      <ol className="m-0 list-none p-0">
        {day.rows.map((row) => (
          <AroundRowView key={row.report.reportId} row={row} safety={safety} />
        ))}
      </ol>
    </>
  );
}

function AroundRowView({ row, safety }: { row: AroundRow; safety: boolean }) {
  const { report } = row;
  const author = report.author;
  return (
    <li
      data-slot="around-row"
      data-this={row.isThis ? '' : undefined}
      data-down={row.down ?? undefined}
      aria-current={row.isThis ? 'true' : undefined}
      className={cn(
        'group/row relative grid grid-cols-[6.5rem_minmax(0,1fr)_6.25rem] gap-(--space-4)',
        'border-0 border-s-(length:--stroke-note) border-solid border-transparent px-gutter pt-(--space-2_5) pb-(--space-3)',
        '[&+&]:border-t-(length:--stroke-hair) [&+&]:border-t-line',
        'hover:bg-lift-03 focus-within:bg-lift-03',
        row.isThis && 'border-s-fg',
      )}
    >
      <div className="font-(family-name:--family-mono) text-mono-sm leading-snug whitespace-nowrap text-fg1">
        <span data-slot="around-time">{row.time}</span>
        {row.vantage !== null && (
          <small className="block text-kick leading-snug font-regular whitespace-normal text-fg3">
            {row.vantage}
          </small>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-(--space-1_5)">
        <div className="flex items-baseline gap-(--space-2) text-row leading-snug">
          <span data-slot="around-author" className="font-medium text-fg">
            {author === null || author.deleted ? W.departed : author.displayName}
          </span>
          {author !== null &&
            !author.deleted &&
            (author.isStaff || report.authorReports !== null) && (
              <span className="text-assist text-fg3">
                · {author.isStaff ? W.staff : W.authorReports(report.authorReports ?? 0)}
              </span>
            )}
          {row.down !== null && (
            <Badge variant="outline" tone="dim" data-slot="around-down" className="self-center">
              {row.down === 'hidden' ? W.hidden : W.removed}
            </Badge>
          )}
        </div>
        {report.notes !== null && report.notes.trim() !== '' && (
          <p className="m-0 text-row leading-body text-fg1">{report.notes}</p>
        )}
        <div className="pe-(--space-10)">
          <ClaimChips chips={claimChips(report.claims, safety && row.isThis)} />
        </div>
      </div>
      <div className="text-right font-(family-name:--family-mono) text-mono-sm leading-snug text-fg2">
        {row.isThis ? (
          <Badge variant="solid" tone="bright" data-slot="around-this">
            {W.thisReport}
          </Badge>
        ) : (
          row.distance !== null && <span data-slot="around-distance">{row.distance}</span>
        )}
        {report.placeName !== null && (
          <small
            className={cn(
              'block font-(family-name:--family-sans) text-kick leading-snug text-fg3',
              row.isThis && 'mt-(--space-1)',
            )}
          >
            {report.placeName}
          </small>
        )}
      </div>
      {!row.isThis && (
        <ComingSoonLink
          data-slot="around-open"
          className="absolute end-gutter bottom-(--space-3) opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100"
        >
          {W.openInReports}
        </ComingSoonLink>
      )}
    </li>
  );
}
