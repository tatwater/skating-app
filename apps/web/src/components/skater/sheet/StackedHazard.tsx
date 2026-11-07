import { sheetReducer, updateReport } from '@skating/core';
import { updateSheet } from '@/lib/sheetStore';
import { HazardSheetFrame } from './HazardSheetFrame';
import type { StackedHazardSlotProps } from './sheetSlots';

/** A hazard filed from inside a Report rides on it (`hazardIds`: "drawn from the sheet"). */
export function carryHazard(reportId: string, hazardId: string): void {
  updateSheet((p) =>
    updateReport(p, reportId, (r) =>
      r.sheet.scalars.hazardIds.includes(hazardId)
        ? r
        : {
            ...r,
            sheet: sheetReducer(r.sheet, {
              type: 'setScalar',
              key: 'hazardIds',
              value: [...r.sheet.scalars.hazardIds, hazardId],
            }),
          },
    ),
  );
}

/**
 * The `stackedHazard` slot (5.10.1): Report a hazard stacked inside the report — its own sheet
 * frame, over the report's header, the report unchanged behind it. The opener already recorded
 * `hazard_flow_started`; the flow does not again. A hazard filed here is offered back to the
 * Report that opened it; a nearby one confirmed instead is the existing hazard's, not this Report's.
 */
export function StackedHazard({
  waterBodyId,
  reportId,
  container,
  onClose,
  seedPhotos,
  onFiled,
}: StackedHazardSlotProps & {
  /** Photos the hazard starts with (a report photo's *This is a hazard…*). */
  seedPhotos?: readonly File[];
  /** The hazard was filed — after it rides on the Report, before the sheet closes. */
  onFiled?: () => void;
}) {
  return (
    <HazardSheetFrame
      waterBodyId={waterBodyId}
      stacked
      container={container}
      onClose={onClose}
      onDone={(result, { open }) => {
        if (result.outcome === 'filed') {
          carryHazard(reportId, result.hazardId);
          onFiled?.();
        }
        // A Post that lands after the skater left has nothing of its own to close; closing here
        // would shut whatever hazard sheet the opener has shown since.
        if (open) onClose();
      }}
      {...(seedPhotos !== undefined ? { seedPhotos } : {})}
    />
  );
}
