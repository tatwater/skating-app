import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/sharp-regular-svg-icons';
import type { SatelliteImageryMode } from '@skating/core';
import { type ComponentProps, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogReason,
  AlertDialogTitle,
} from '@/components/kit/alert-dialog';
import { Avatar } from '@/components/kit/avatar';
import { Badge } from '@/components/kit/badge';
import { Button, buttonVariants } from '@/components/kit/button';
import { Kbd } from '@/components/kit/kbd';
import { Section } from '@/components/kit/section-slug';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/kit/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';

import {
  CLEAR_GATE_PCT,
  COVERAGE_GATE_PCT,
  isShown,
  type PassRow,
  passCount,
  satelliteAssist,
  selectedPass,
} from './imageryModel';
import { ThresholdMeter } from './kit-candidates/threshold-meter';

/**
 * Board 5.4.6, Body › Imagery's inspector, the default view: the lit pass as a card — its date,
 * who sees it, the two gates that decide that, the one call on it, and the way to the next pass —
 * then every pass this winter, then the satellite link (moved here from Water).
 *
 * **What a satellite saw, never what the ice will hold.** The gates are cloud and coverage; a pass
 * that clears them is *shown to skaters*, not good, and nothing here reads the picture.
 *
 * The lit pass is controlled (`lit`, `onLitChange`): the dock and the table move it together.
 */

export type ImageryTabViewProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** "Winter 2026–27"; `null` while the archive's season is unknown. */
  season: string | null;
  /** Oldest first. `undefined` while loading; `[]` when no pass reached this body. */
  rows: readonly PassRow[] | undefined;
  /** The archive could not be read — a fact about the archive, never about the lake. */
  archiveError?: boolean;
  lit: string | null;
  onLitChange: (id: string) => void;
  /**
   * Show a hidden pass anyway, or hide a shown one. Hiding takes the pass from skaters, so it asks
   * a reason first; showing asks nothing. Absent: no call is offered.
   */
  onOverride?: (id: string, verdict: 'show' | 'hide', reason?: string) => Promise<void>;
  satellite: {
    mode: SatelliteImageryMode;
    name: string | undefined;
    areaSqM: number | undefined;
    /** The Copernicus link for this body, or `null` with no point to open it on. */
    url: string | null;
  };
  /** Set the satellite link. Absent: the choice is drawn read-only. */
  onSatelliteChange?: (mode: SatelliteImageryMode) => Promise<void>;
};

const SATELLITE_CHOICES: ReadonlyArray<{ value: SatelliteImageryMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'Always offer' },
  { value: 'off', label: 'Never' },
];

export function ImageryTabView({
  season,
  rows,
  archiveError = false,
  lit,
  onLitChange,
  onOverride,
  satellite,
  onSatelliteChange,
  className,
  ...props
}: ImageryTabViewProps) {
  const pane = useRef<HTMLDivElement>(null);
  const passes = rows ?? [];
  const index = selectedPass(passes, lit);
  const row = passes[index];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hidden = row !== undefined && !isShown(row.seen);

  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  const write = async (verdict: 'show' | 'hide', why?: string) => {
    if (row === undefined || !onOverride) return false;
    setBusy(true);
    setError(null);
    try {
      await onOverride(row.id, verdict, why);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const call = () => {
    if (hidden) {
      void write('show');
      return;
    }
    setReason('');
    setError(null);
    setAsking(true);
  };
  const [satError, setSatError] = useState<string | null>(null);
  const setSatellite = async (mode: SatelliteImageryMode) => {
    if (!onSatelliteChange) return;
    setSatError(null);
    try {
      await onSatelliteChange(mode);
    } catch (err) {
      setSatError(err instanceof Error ? err.message : String(err));
    }
  };
  const go = (to: number) => {
    const next = passes[to];
    if (next !== undefined) onLitChange(next.id);
  };

  // The call's key is its label's letter, and acts only while this pane has focus.
  usePaneKeys(pane, [
    {
      key: 'S',
      run: call,
      enabled: onOverride !== undefined && hidden && !busy,
      label: 'Show to skaters anyway',
    },
    {
      key: 'H',
      run: call,
      enabled: onOverride !== undefined && row !== undefined && !hidden && !busy,
      label: 'Hide from skaters',
    },
  ]);

  const count = passCount(passes);

  return (
    <div
      ref={pane}
      data-slot="imagery-tab"
      className={cn('flex flex-col gap-(--space-5_5)', className)}
      {...props}
    >
      <Section
        title="Freeze-up imagery"
        end={
          season === null ? undefined : (
            <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
              {season}
            </span>
          )
        }
      >
        {rows === undefined ? (
          <p className="m-0 text-assist text-fg3">{archiveError ? '' : 'Loading the passes'}</p>
        ) : row === undefined ? (
          <p className="m-0 text-assist text-fg3">
            No satellite pass reached this body this winter
          </p>
        ) : (
          <div
            data-slot="pass-card"
            className="corner-dots flex flex-col gap-(--space-2_5) bg-raise px-(--space-4) pt-(--space-3) [--dot-opacity:1]"
          >
            <div className="flex items-center justify-between gap-(--space-2_5)">
              <span className="flex items-baseline gap-(--space-2_5) whitespace-nowrap">
                <b
                  data-slot="pass-day"
                  className="text-h leading-none font-medium tracking-label text-fg"
                >
                  {row.day}
                </b>
                <span className="text-assist leading-none text-fg2">{row.weekday}</span>
              </span>
              {hidden ? (
                <Badge variant="outline">Hidden from skaters</Badge>
              ) : (
                <Badge variant="outline" tone="lit">
                  Shown to skaters
                </Badge>
              )}
            </div>
            <div className="mt-(--space-1) flex flex-col gap-(--space-2)">
              <ThresholdMeter
                label="Clear of cloud"
                value={row.clearPct}
                threshold={CLEAR_GATE_PCT}
                unit="%"
              />
              <ThresholdMeter
                label="Lake in the pass"
                value={row.coveragePct}
                threshold={COVERAGE_GATE_PCT}
                unit="%"
              />
            </div>
            {onOverride !== undefined && (
              <Button size="sm" loading={busy} className="w-full" onClick={call}>
                {hidden ? 'Show to skaters anyway' : 'Hide from skaters'}
                <Kbd variant="dim">{hidden ? 'S' : 'H'}</Kbd>
              </Button>
            )}
            {error !== null && !asking && (
              <p role="alert" className="m-0 text-assist text-bad">
                {error}
              </p>
            )}
            <div
              data-slot="pass-pager"
              className="-mx-(--space-4) grid grid-cols-[1fr_auto_1fr] items-center gap-(--space-3) border-t border-solid border-line px-(--space-4) py-(--space-2)"
            >
              <Button
                size="xs"
                className="justify-self-start"
                disabled={index === 0}
                focusableWhenDisabled
                onClick={() => go(index - 1)}
              >
                <Kbd variant="dim">←</Kbd>
                Previous
              </Button>
              <span className="font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3">
                {index + 1} of {passes.length}
              </span>
              <Button
                size="xs"
                className="justify-self-end"
                disabled={index === passes.length - 1}
                focusableWhenDisabled
                onClick={() => go(index + 1)}
              >
                Next
                <Kbd variant="dim">→</Kbd>
              </Button>
            </div>
          </div>
        )}
      </Section>

      {passes.length > 0 && (
        <Section
          title="Passes"
          end={
            <span className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase">
              {count.total} · {count.hidden} hidden
            </span>
          }
        >
          <Table className="-mx-gutter w-[calc(100%+2*var(--gap-gutter))]">
            <TableHeader>
              <tr>
                <TableHead>Date</TableHead>
                <TableHead align="end">Cloud</TableHead>
                <TableHead align="end">Coverage</TableHead>
                <TableHead>Skaters</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {[...passes].reverse().map((p) => (
                <TableRow
                  key={p.id}
                  clickable
                  selected={p.id === row?.id}
                  data-pass={p.id}
                  onClick={() => onLitChange(p.id)}
                >
                  <TableCell lead>{p.day}</TableCell>
                  <Figure value={p.cloudPct} failed={p.blockedBy === 'cloud'} />
                  <Figure value={p.coveragePct} failed={p.blockedBy === 'coverage'} />
                  <TableCell>
                    <SeenCell row={p} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      <Section
        title="Satellite link"
        end={
          satellite.url === null ? undefined : (
            <a
              href={satellite.url}
              target="_blank"
              rel="noreferrer"
              data-slot="button"
              className={buttonVariants({ variant: 'link', size: 'xs' })}
            >
              Copernicus Browser
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-[0.9em]" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )
        }
      >
        <ToggleGroup
          aria-label="Satellite link"
          variant="well"
          value={satellite.mode}
          disabled={onSatelliteChange === undefined}
          onValueChange={(v) => void setSatellite(v as SatelliteImageryMode)}
          className="flex w-full [&>*]:flex-1"
        >
          {SATELLITE_CHOICES.map((c) => (
            <ToggleGroupItem key={c.value} value={c.value}>
              {c.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="m-0 text-assist leading-(--lead-list) text-fg3">
          {satelliteAssist(satellite.name, satellite.areaSqM, satellite.mode)}
        </p>
        {satError !== null && (
          <p role="alert" className="m-0 text-assist text-bad">
            {satError}
          </p>
        )}
      </Section>
      <AlertDialog
        open={asking}
        onOpenChange={(open) => {
          if (!open && !busy) setAsking(false);
        }}
      >
        <AlertDialogContent data-slot="hide-pass-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Hide this pass from skaters?</AlertDialogTitle>
            <AlertDialogDescription>
              {row?.date}. Skaters stop landing on it; it stays here, and Show anyway brings it
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            {error !== null && <AlertDialogError>{error}</AlertDialogError>}
            <AlertDialogReason value={reason} onChange={(e) => setReason(e.target.value)} />
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction
              destructive
              waiting={reason.trim().length === 0 || busy}
              onClick={() => {
                void write('hide', reason.trim()).then((ok) => {
                  if (ok) setAsking(false);
                });
              }}
            >
              Hide from skaters
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A percentage cell; the figure that hid the pass is the bright one; not measured is absent. */
function Figure({ value, failed }: { value: number | null; failed: boolean }) {
  return (
    <TableCell align="end" mono className={cn(failed && 'text-fg')}>
      {value === null ? (
        <span className="sr-only">Not measured</span>
      ) : (
        <>
          {value}
          <span className={cn('ms-[0.6em]', failed ? 'text-fg2' : 'text-fg3')}>%</span>
        </>
      )}
    </TableCell>
  );
}

const STAFF_DAY = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });

function SeenCell({ row }: { row: PassRow }) {
  if (row.seen === 'shown') return <span>Shown</span>;
  if (row.seen === 'hidden') return <span className="text-fg3">Hidden</span>;
  const o = row.override;
  return (
    <span className="flex flex-col gap-(--space-1)">
      <span className={row.seen === 'shown-anyway' ? 'text-warn' : 'text-fg3'}>
        {row.seen === 'shown-anyway' ? 'Shown anyway' : 'Hidden by staff'}
      </span>
      {o !== null && (
        <span className="flex items-baseline gap-(--space-2_5) text-assist">
          <span className="inline-flex items-center gap-(--space-1_5) text-fg1">
            <Avatar name={o.by} size="sm" aria-hidden="true" />
            {o.by}
          </span>
          <span className="font-(family-name:--family-mono) text-kick tracking-micro text-fg3 uppercase">
            {formatParts(o.at)}
          </span>
        </span>
      )}
    </span>
  );
}

function formatParts(at: number): string {
  const parts = STAFF_DAY.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')}`;
}
