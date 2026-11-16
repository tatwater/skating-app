import type { SheetReport } from '@skating/core';
import { useFeatureFlag } from '@/lib/featureFlags';
import { useSheet } from '@/lib/sheetStore';
import { useSheetSlots } from './sheetSlots';

/**
 * *Add your GPS track* once a Report has its lake (board 5.1, the map key's end; board 9.8's strip on
 * a phone): the same GPX import the *Which lake?* card offers before a lake, so a track can be added
 * at every point of a create — a second Report, after a failed send, after a reload. Not once the
 * Report has a track, not on an edit (an edit's activity is the published one's), and behind the
 * same `gpx-import` flag as the card. A track that disagrees with the author's lake or day is
 * refused, not re-sorted (`trackRefusal`).
 */
export function AddTrack({
  report,
  timeZone,
  className,
}: {
  report: SheetReport;
  timeZone: string;
  className?: string;
}) {
  const enabled = useFeatureFlag('gpx-import', false);
  const { gpxImport } = useSheetSlots();
  const editing = useSheet()?.mode.kind === 'edit';
  if (!enabled || gpxImport === undefined || editing || report.activityId !== undefined)
    return null;
  return (
    <div data-slot="add-track" className={className}>
      {gpxImport({ reportId: report.id, variant: 'link', timeZone, onImported: () => {} })}
    </div>
  );
}
