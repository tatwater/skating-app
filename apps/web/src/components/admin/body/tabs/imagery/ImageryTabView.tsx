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
import { Meter } from '@/components/kit/meter';
import { Note } from '@/components/kit/note';
import { Plate } from '@/components/kit/plate';
import { RetryNote } from '@/components/kit/retry-note';
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
import {
  sayUnavailable,
  UNAVAILABLE,
  UnavailableButton,
} from '@/components/kit/unavailable-button';
import { cn } from '@/lib/utils';
import { usePlace } from '../../../place';
import { notSavedWhat, PICK_WHAT } from '../../consoleWords';
import { dayMonth } from '../../frame/bodyModel';
import { sayNotSaved, useBodyHold } from '../../frame/currentBody';
import { useTabKeys } from '../../frame/tabKeys';
import { outcomeOf, useLatestPick } from '../latestPick';
import { LoadingSection } from '../tabParts';

import {
  CLEAR_GATE_PCT,
  COVERAGE_GATE_PCT,
  isShown,
  type PassRow,
  passCount,
  satelliteAssist,
  selectedPass,
} from './imageryModel';

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
  /** This deployment has no address for the archive, so nothing can be read from it. */
  archiveUnconfigured?: boolean;
  /** Read the archive again after a failure. Absent: no *Try again*. */
  onRetry?: () => void;
  /** The failed reads were tried again; their fresh answers aren't in. */
  retryPending?: boolean;
  lit: string | null;
  onLitChange: (id: string) => void;
  /**
   * Show a hidden pass anyway, or hide a shown one. Hiding takes the pass from skaters, so it asks
   * a reason first; showing asks nothing. Absent: no call is offered; `'unavailable'`: the call is
   * drawn and says *Not available yet* (no writer on the server).
   */
  onOverride?:
    | ((id: string, verdict: 'show' | 'hide', reason?: string) => Promise<void>)
    | typeof UNAVAILABLE;
  satellite: {
    /**
     * Whose link: its presses queue by body, outside the tab (`useLatestPick`). Required: a queue
     * shared by every body would send one body's waiting press through another body's writer.
     */
    bodyId: string;
    mode: SatelliteImageryMode;
    name: string | undefined;
    areaSqM: number | undefined;
    /** The Copernicus link for this body, or `null` with no point to open it on. */
    url: string | null;
  };
  /**
   * Set the satellite link. Absent: the choice is drawn read-only. Throws the server's words for a
   * refusal to say here; answers `false` for one already said (off its page).
   */
  onSatelliteChange?: (mode: SatelliteImageryMode) => Promise<unknown>;
};

/** What the pass call will do, for its *Not available yet*. */
const OVERRIDE_WHAT =
  'A staff call on a pass, showing a clouded pass anyway or hiding a shown one, comes with the pass override.';

const SATELLITE_CHOICES: ReadonlyArray<{ value: SatelliteImageryMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'Always offer' },
  { value: 'off', label: 'Never' },
];

/** A satellite choice in the control's words. */
const choiceLabel = (mode: SatelliteImageryMode): string =>
  SATELLITE_CHOICES.find((c) => c.value === mode)?.label ?? mode;

/** A refused choice, named, so it never reads as a later choice's refusal. */
const notSavedChoice = (label: string, why: string): string => `“${label}” wasn’t saved: ${why}`;

export function ImageryTabView({
  season,
  rows,
  archiveError = false,
  archiveUnconfigured = false,
  onRetry,
  retryPending = false,
  lit,
  onLitChange,
  onOverride: override,
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
  const unavailable = override === UNAVAILABLE;
  const onOverride = unavailable ? undefined : override;

  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const askOpening = useRef(0);
  const wasAsking = useRef(false);
  if (asking && !wasAsking.current) askOpening.current++;
  wasAsking.current = asking;

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
    if (unavailable) {
      sayUnavailable(OVERRIDE_WHAT);
      return;
    }
    if (hidden) {
      void write('show');
      return;
    }
    setReason('');
    setError(null);
    setAsking(true);
  };
  // The satellite link: the latest press always wins — shown at once, sent one write at a time in
  // press order (a press waiting behind the write out is replaced by a newer one), the server's
  // answer drawn again once every write has answered (`useLatestPick`).
  const hold = useBodyHold();
  // Where a refusal of the link is said: under the control, while that is drawn.
  const satPlace = usePlace();
  const sat = useLatestPick<SatelliteImageryMode>(
    `imagery-satellite:${satellite.bodyId}`,
    satellite.mode,
    {
      // Refused here, the write path throws the server's words for this control to say in place;
      // refused off its page, it has said it already and answers `false`.
      send: (mode) => outcomeOf(() => onSatelliteChange?.(mode)),
      say: (why) => sayNotSaved(hold, notSavedWhat(PICK_WHAT.satellite, why)),
      inPlace: satPlace,
    },
  );
  const go = (to: number) => {
    const next = passes[to];
    if (next !== undefined) onLitChange(next.id);
  };

  // The call's key is its label's letter, and acts while focus is anywhere in the inspector.
  useTabKeys(pane, [
    {
      key: 'S',
      run: call,
      enabled: override !== undefined && hidden && !busy,
      label: 'Show to skaters anyway',
    },
    {
      key: 'H',
      run: call,
      enabled: override !== undefined && row !== undefined && !hidden && !busy,
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
        {/* Mounted in every state: a failure's words are announced, and focus stays when they go. */}
        <RetryNote data-slot="archive-failed" onRetry={onRetry} pending={retryPending}>
          {rows === undefined && !archiveUnconfigured && archiveError
            ? 'The imagery archive couldn’t be read. That is about the archive, not the lake.'
            : null}
        </RetryNote>
        {rows === undefined ? (
          archiveUnconfigured ? (
            <Note data-slot="archive-unconfigured">
              No imagery archive is set up for this deployment, so no passes can be read here.
            </Note>
          ) : archiveError ? null : (
            <div aria-busy="true" data-slot="passes-loading">
              <LoadingSection lines={4} />
            </div>
          )
        ) : row === undefined ? (
          <p className="m-0 text-assist text-fg3">
            No satellite pass reached this body this winter
          </p>
        ) : (
          <Plate data-slot="pass-card" className="pb-0">
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
              <GateRow
                label="Clear of cloud"
                value={row.clearPct}
                threshold={CLEAR_GATE_PCT}
                blocked={row.blockedBy === 'cloud'}
                unit="%"
              />
              <GateRow
                label="Lake in the pass"
                value={row.coveragePct}
                threshold={COVERAGE_GATE_PCT}
                blocked={row.blockedBy === 'coverage'}
                unit="%"
              />
            </div>
            {unavailable ? (
              <UnavailableButton size="sm" className="w-full" what={OVERRIDE_WHAT}>
                {hidden ? 'Show to skaters anyway' : 'Hide from skaters'}
                <Kbd variant="dim">{hidden ? 'S' : 'H'}</Kbd>
              </UnavailableButton>
            ) : (
              onOverride !== undefined && (
                <Button size="sm" loading={busy} className="w-full" onClick={call}>
                  {hidden ? 'Show to skaters anyway' : 'Hide from skaters'}
                  <Kbd variant="dim">{hidden ? 'S' : 'H'}</Kbd>
                </Button>
              )
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
          </Plate>
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
          value={sat.shown}
          disabled={onSatelliteChange === undefined}
          // The kit's group never hands over nothing chosen, and is inert without a writer.
          onValueChange={(v) => sat.press(v as SatelliteImageryMode)}
          className="flex w-full [&>*]:flex-1"
        >
          {SATELLITE_CHOICES.map((c) => (
            <ToggleGroupItem key={c.value} value={c.value}>
              {c.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p ref={satPlace.ref} className="m-0 text-assist leading-(--lead-list) text-fg3">
          {satelliteAssist(satellite.name, satellite.areaSqM, sat.shown)}
        </p>
        {sat.error !== null && (
          <p role="alert" className="m-0 text-assist text-bad">
            {notSavedChoice(choiceLabel(sat.error.value), sat.error.why)}
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
            {/* A sent reason is held while its one-shot write is out (it can't be sent again). */}
            <AlertDialogReason
              value={reason}
              readOnly={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction
              destructive
              waiting={reason.trim().length === 0 || busy}
              onClick={() => {
                // The ask open now: its answer closes this opening, never one opened since.
                const mine = askOpening.current;
                void write('hide', reason.trim()).then((ok) => {
                  if (ok && askOpening.current === mine) setAsking(false);
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

/**
 * A pass no manifest measured over this lake (its coverage `basis` inferred from the footprint, or
 * unknown): its cloud and coverage are said to be unmeasured, never left blank or drawn as a zero.
 */
export const NOT_MEASURED = 'Not measured';

/** A percentage cell; the figure that hid the pass is the bright one; not measured says so. */
function Figure({ value, failed }: { value: number | null; failed: boolean }) {
  return (
    <TableCell align="end" mono className={cn(failed && 'text-fg')}>
      {value === null ? (
        <span data-slot="not-measured" className="font-sans text-kick whitespace-nowrap text-fg3">
          {NOT_MEASURED}
        </span>
      ) : (
        <>
          {value}
          <span className={cn('ms-unit', failed ? 'text-fg2' : 'text-fg3')}>%</span>
        </>
      )}
    </TableCell>
  );
}

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
            {dayMonth(o.at)}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * One gate a pass must clear (board 5.4.6's `.gate`): the name over what it needs, the kit `Meter`
 * with its white gate tick (`markTone="lit"` — passing is not a warning, so not amber), and the
 * figure with its unit. A value under its gate is the bright one: the name and figure go to the
 * bright ink and the fill steps back to `dim`. **Not measured is said, never drawn as zero**: no
 * meter or track at all (an empty one reads as zero), *Not measured* in words across both columns.
 *
 * **The gate that hid the pass always fails here** (`blocked`, core's own verdict), whatever the
 * figure: the figure is rounded (59.6 % clear reads "60 %" under a 60 % gate) and a pass with no
 * manifest is hidden on the scene's cloud, so the figure alone would draw a hidden pass's gate as
 * cleared.
 */
function GateRow({
  label,
  value,
  threshold,
  blocked,
  unit = '',
}: {
  label: string;
  /** In percent; `null` when nobody measured it. */
  value: number | null;
  threshold: number;
  /** This gate is the one core says hid the pass (`blockedBy`). */
  blocked: boolean;
  unit?: string;
}) {
  const fails = blocked || (value !== null && value < threshold);
  return (
    <div
      data-slot="gate-row"
      data-fails={fails ? '' : undefined}
      data-unmeasured={value === null ? '' : undefined}
      // The board's columns: the name 104 px, the figure 46 px — the row's own dimensions.
      className="group/gate grid grid-cols-[6.5rem_minmax(0,1fr)_2.875rem] items-center gap-x-(--space-3)"
    >
      <span className="flex flex-col gap-(--space-1)">
        <span className="text-assist leading-(--lead-snug) whitespace-nowrap text-fg1 group-data-fails/gate:text-fg">
          {label}
        </span>
        <span className="text-kick leading-(--lead-snug) whitespace-nowrap text-fg3">
          Needs {threshold}
          {unit}
        </span>
      </span>
      {value === null ? (
        // Unmeasured: said in words across the meter and the figure — an empty meter would read
        // as zero, and a blank as nothing to say.
        <span
          data-slot="gate-value"
          className="col-span-2 text-assist leading-none whitespace-nowrap text-fg3"
        >
          {NOT_MEASURED}
        </span>
      ) : (
        <>
          <Meter
            aria-label={label}
            value={Math.min(100, Math.max(0, value))}
            mark={threshold}
            markTone="lit"
            tone={fails ? 'dim' : 'default'}
            getAriaValueText={() => `${value}${unit}, needs ${threshold}${unit}`}
          />
          <span
            data-slot="gate-value"
            aria-hidden="true"
            className="text-right font-(family-name:--family-mono) text-mono-sm leading-none font-medium whitespace-nowrap text-fg2 tabular-nums group-data-fails/gate:text-fg"
          >
            {value}
            {unit !== '' && <span className="ms-unit text-fg3">{unit}</span>}
          </span>
        </>
      )}
    </div>
  );
}
