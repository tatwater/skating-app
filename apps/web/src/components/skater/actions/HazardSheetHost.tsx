import { HazardSheetFrame } from '../sheet/HazardSheetFrame';

/**
 * The lake's *Report a hazard* (`?act=hazard`, boards 3.1–3.8) in **the New report sheet's frame**
 * (Review 2: the map on the left, only the hazard's questions on the right) — a sheet over the lake
 * page, as the report sheet sits, with its own short-lived instrument map beside J's flow. The
 * region map stays behind the scrim exactly as the lake's view declared it.
 *
 * While a report sheet is open over the same page (`?post=`), this one steps aside: the report's
 * instrument and this one's would be two maps over the region's, and the GL budget is two. The
 * draft is the store's, so it is all still there when the report closes.
 */
export function HazardSheetHost({
  waterBodyId,
  subAreaId,
  reportOpen,
  onClose,
}: {
  waterBodyId: string;
  subAreaId?: string;
  /** `?post=` is on the URL: the report sheet has the screen. */
  reportOpen: boolean;
  onClose: () => void;
}) {
  if (reportOpen) return null;
  return (
    <HazardSheetFrame
      waterBodyId={waterBodyId}
      {...(subAreaId !== undefined ? { subAreaId } : {})}
      onClose={onClose}
    />
  );
}
