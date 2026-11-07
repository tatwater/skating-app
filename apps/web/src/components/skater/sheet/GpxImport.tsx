import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type PostSheet, reportEndMs, sheetReducer, updateReport } from '@skating/core';
import { useConvex, useMutation } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useRef, useState } from 'react';
import { Button } from '@/components/kit/button';
import { bucketPointCount, useAnalytics } from '@/lib/analytics';
import { type GpxIngestPlan, planGpxFile } from '@/lib/gpxParse';
import { updateSheet } from '@/lib/sheetStore';
import { setReportBody } from './sheetModel';
import type { GpxImportSlotProps } from './sheetSlots';

/** The server's refusal in its own words — ingest errors are plain strings (B03 §11). */
export function ingestMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === 'string') return error.data;
  return "Couldn't import that track. Check your connection and try again.";
}

/**
 * The track lands on the Report: the activity linked, and the lake, the day and the times seeded
 * where the sheet is blank — never over what the author already answered. The times are the
 * track's own (`gps`), so the ruler draws them exactly; the lake is the one the server resolved.
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
    if (reportEndMs(r) !== undefined) return r;
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
 * The `gpxImport` slot (5.2, flag `gpx-import`): choose or drop a GPX file → parsed and thinned on
 * this device (`planGpxFile`) → `gpsActivities.ingestTrack({ provider: 'gpx' })`, which resolves the
 * lake and refuses a file outside the seven-day window → the track lands on the instrument.
 * A refusal is shown in the server's words, verbatim. D239: the track is the route the file
 * describes; nothing here calls it verified.
 */
export function GpxImport({ reportId, onImported }: GpxImportSlotProps) {
  const convex = useConvex();
  const ingest = useMutation(api.gpsActivities.ingestTrack);
  const { capture } = useAnalytics();
  const inputRef = useRef<HTMLInputElement>(null);
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
    <fieldset
      aria-label="Import a GPX file"
      className="m-0 flex min-w-0 flex-col items-center gap-(--space-2) border-0 p-0"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void run(e.dataTransfer.files[0]);
      }}
    >
      <Button
        size="sm"
        loading={busy}
        data-attr="gpx-choose"
        onClick={() => inputRef.current?.click()}
      >
        <FontAwesomeIcon icon={faPlus} />
        {busy ? 'Reading the track…' : 'Choose a file'}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        hidden
        aria-label="A GPX file"
        onChange={(e) => {
          void run(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error !== null ? (
        <p
          role="alert"
          className="m-0 max-w-60 text-assist leading-body text-warn [text-wrap:pretty]"
        >
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
