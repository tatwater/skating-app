import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRoute } from '@fortawesome/sharp-light-svg-icons';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  type PostSheet,
  type SheetReport,
  selectedChips,
  sheetReducer,
  updateReport,
} from '@skating/core';
import { useConvex, useMutation } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useRef, useState } from 'react';
import { Button } from '@/components/kit/button';
import { bucketPointCount, useAnalytics } from '@/lib/analytics';
import { type GpxIngestPlan, planGpxFile } from '@/lib/gpxParse';
import { getSheet, updateSheet } from '@/lib/sheetStore';
import { cn } from '@/lib/utils';
import { dayKey } from './photoSort';
import { setReportBody } from './sheetModel';
import type { GpxImportSlotProps } from './sheetSlots';

/** The server's refusal in its own words — ingest errors are plain strings (B03 §11). */
export function ingestMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === 'string') return error.data;
  return "Couldn't import that track. Check your connection and try again.";
}

/**
 * The end time the *author* gave, if any. A phone's daylight preselect of "now" is the sheet's
 * doing (`defaulted`), not an answer: it neither refuses a track from another day nor stands
 * against the track's exact times.
 */
function authoredEndMs(report: SheetReport): number | undefined {
  const [chip] = selectedChips(report.sheet, 'endTime');
  return chip === undefined || chip.defaulted === true ? undefined : chip.value.ms;
}

/**
 * The track lands on the Report: the activity linked, and the lake, the day and the times seeded
 * where the sheet is blank — never over what the author already answered. The times are the
 * track's own (`gps`), so the ruler draws them exactly; the lake is the one the server resolved.
 * A defaulted end (a phone's "now") is not an answer, so the track's times replace it.
 */
export function seedFromTrack(
  post: PostSheet,
  reportId: string,
  activityId: string,
  plan: { startTime: number; endTime: number },
  lake: { waterBodyId: string; name: string } | null,
): PostSheet {
  let next = updateReport(post, reportId, (r) => ({ ...r, activityId }));
  const report = next.reports.find((r) => r.id === reportId);
  if (report === undefined) return post;
  if (lake !== null && report.sheet.waterBodyId === undefined)
    next = setReportBody(next, reportId, lake);
  return updateReport(next, reportId, (r) => {
    if (authoredEndMs(r) !== undefined) return r;
    let sheet = sheetReducer(r.sheet, {
      type: 'select',
      field: 'endTime',
      key: 'gps',
      value: { ms: plan.endTime, precision: 'gps' },
    });
    if (r.sheet.scalars.skateStartTime === undefined)
      sheet = sheetReducer(sheet, {
        type: 'setScalar',
        key: 'skateStartTime',
        value: plan.startTime,
      });
    return { ...r, sheet };
  });
}

/**
 * Whether a track may land on a Report that already has answers — `null` when it may, else the
 * sentence that says why not. The author's lake and day stand: a track on another lake, or off every
 * lake we know, or from another day than the one the author chose, is not linked to this Report and
 * nothing on it moves (the track is in their activities either way, for a Report of its own). A
 * Report with no lake yet takes the track's; one with no end time yet — or only the sheet's
 * defaulted "now" — takes the track's times, if a start the author chose fits them.
 */
export function trackRefusal(
  report: SheetReport,
  plan: { startTime: number; endTime: number },
  lake: { waterBodyId: string; name: string } | null,
  timeZone: string,
): string | null {
  const chosen = report.sheet.waterBodyId;
  if (chosen !== undefined && lake?.waterBodyId !== chosen) {
    const here = report.bodyName ?? 'this lake';
    return lake === null
      ? `We couldn't place that track on ${here}. Start a report from it to keep it.`
      : `That track is on ${lake.name}, not ${here}. Add it as another report to keep it.`;
  }
  const end = authoredEndMs(report);
  const otherDay = `That track is from ${longDay(plan.endTime, timeZone)}, not the day of this report.`;
  if (end !== undefined) {
    return dayKey(end, timeZone) !== dayKey(plan.endTime, timeZone) ? otherDay : null;
  }
  // The track's times will replace a missing or defaulted end; a start the author chose stays, so
  // it has to fit them by Post's own rule — strictly before the end (`resolveSkateWindow`), else the
  // Report would hold a start after its end, locked by the track. A start the night before a track
  // that runs past midnight fits; one more than a day before the track's end is another day's.
  const start = report.sheet.scalars.skateStartTime;
  if (start !== undefined) {
    if (plan.endTime - start > DAY_MS) return otherDay;
    if (start >= plan.endTime) {
      const at = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(plan.endTime);
      return `That track ends at ${at}, before the start you chose.`;
    }
  }
  return null;
}

const DAY_MS = 24 * 3_600_000;

function longDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(ms);
}

/**
 * The `gpxImport` slot (5.2, flag `gpx-import`): choose or drop a GPX file → parsed and thinned on
 * this device (`planGpxFile`) → `gpsActivities.ingestTrack({ provider: 'gpx' })`, which resolves the
 * lake and refuses a file outside the seven-day window → the track lands on the instrument.
 * A refusal is shown in the server's words, verbatim. D239: the track is the route the file
 * describes; nothing here calls it verified.
 */
export function GpxImport({
  reportId,
  onImported,
  variant = 'drop',
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}: GpxImportSlotProps) {
  const convex = useConvex();
  const ingest = useMutation(api.gpsActivities.ingestTrack);
  const { capture } = useAnalytics();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (file: File | undefined) => {
    if (file === undefined) return;
    setError(null);
    setBusy(true);
    capture('gpx_import_started');
    try {
      const plan: GpxIngestPlan = await planGpxFile(file, reportId);
      if (!plan.ok) {
        setError(plan.message);
        return;
      }
      const activityId = await ingest({
        idempotencyKey: plan.idempotencyKey,
        provider: 'gpx',
        path: plan.path,
        startTime: plan.startTime,
        endTime: plan.endTime,
        elapsedSeconds: plan.elapsedSeconds,
      });
      const lake = await resolveLake(activityId);
      const report = getSheet()?.reports.find((r) => r.id === reportId);
      const refused = report === undefined ? null : trackRefusal(report, plan, lake, timeZone);
      if (refused !== null) {
        setError(refused);
        return;
      }
      updateSheet((p) => seedFromTrack(p, reportId, activityId as string, plan, lake));
      capture('gpx_import_completed', { point_count_bucket: bucketPointCount(plan.pointCount) });
      onImported();
    } catch (e) {
      setError(ingestMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // The activity's lake, from the author's own activities (the server resolved it at ingest).
  const resolveLake = async (
    activityId: Id<'gpsActivities'>,
  ): Promise<{ waterBodyId: string; name: string } | null> => {
    const mine = await convex.query(api.gpsActivities.listMine, {});
    const row = mine.find((a) => a.activityId === activityId);
    return row?.waterBodyId !== undefined && row.waterBodyName !== null
      ? { waterBodyId: row.waterBodyId, name: row.waterBodyName }
      : null;
  };

  return (
    <GpxImportView variant={variant} busy={busy} error={error} onFile={(file) => void run(file)} />
  );
}

/** The drop zone's controls, Convex-free: choose or drop a file; the refusal under them, verbatim. */
export function GpxImportView({
  variant = 'drop',
  busy,
  error,
  onFile,
}: {
  variant?: 'drop' | 'link';
  busy: boolean;
  error: string | null;
  onFile: (file: File | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const link = variant === 'link';
  return (
    <fieldset
      aria-label="Import a GPX file"
      className={cn(
        'm-0 flex min-w-0 gap-(--space-2) border-0 p-0',
        // The link sits on the map's key row: its refusal stacks above it, not over the map's foot.
        link ? 'flex-col-reverse items-end' : 'flex-col items-center',
      )}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFile(e.dataTransfer.files[0]);
      }}
    >
      {link ? (
        <Button
          size="xs"
          loading={busy}
          data-attr="gpx-add-track"
          onClick={() => inputRef.current?.click()}
        >
          <FontAwesomeIcon icon={faRoute} />
          {busy ? 'Reading the track…' : 'Add your GPS track'}
        </Button>
      ) : (
        <Button
          size="sm"
          loading={busy}
          data-attr="gpx-choose"
          onClick={() => inputRef.current?.click()}
        >
          <FontAwesomeIcon icon={faPlus} />
          {busy ? 'Reading the track…' : 'Choose a file'}
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        hidden
        aria-label="A GPX file"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error !== null ? (
        <p
          role="alert"
          className={cn(
            'm-0 max-w-60 text-assist leading-body text-warn [text-wrap:pretty]',
            link && 'border border-solid border-line bg-panel p-(--space-2)',
          )}
        >
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
