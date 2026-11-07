import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTriangleExclamation } from '@fortawesome/sharp-regular-svg-icons';
import type { DraftPhoto } from '@skating/core';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { Button } from '@/components/kit/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { useAnalytics } from '@/lib/analytics';

/**
 * The report sheet's mount points (B03 §5): the flows the sheet's second half brings (agent K),
 * each a render prop the sheet calls where the flow belongs. The sheet core draws the affordance and
 * owns the open/closed state; a missing slot leaves the affordance inert, never a dead end.
 *
 * Provide them once, above the sheet, with `SheetSlotsProvider`.
 */

/** 5.10.1 — Report a hazard, stacked inside the report (covers the report's header). */
export interface StackedHazardSlotProps {
  waterBodyId: string;
  /** The Report whose Hazards section opened it — the new hazard is offered back to it. */
  reportId: string;
  /** The sheet's own element: portal the stacked sheet here so it stacks *inside* the report. */
  container: HTMLElement | null;
  /** The flow closed (posted or not). One Esc: the stacked sheet takes it while it is open. */
  onClose: () => void;
}

/** 5.2 — the GPX card's import flow (flag `gpx-import` on). */
export interface GpxImportSlotProps {
  /** The Report the track seeds (its lake, day and times). */
  reportId: string;
  /** The import seeded the report; the card gives way to the instrument. */
  onImported: () => void;
}

/** 5.19 — a photo tile's menu (which lake, place it, this is a hazard, leave it out). */
export interface PhotoTileMenuSlotProps {
  photo: DraftPhoto;
  /** The Report the photo is on, or `null` for the Post's pool. */
  reportId: string | null;
  /** The tile's corner mark, to render as the menu's trigger. */
  trigger: ReactNode;
}

/** 5.21 — Google Photos: hands the picked photos back as drafts. */
export interface GooglePhotosSlotProps {
  disabled: boolean;
  onPhotos: (drafts: DraftPhoto[]) => void;
}

/** 5.16/5.17 — *Another report*: the same lake at another time, or a different lake. */
export interface AnotherReportSlotProps {
  /** The Report on screen — "the same lake, another time" is its lake. */
  activeReportId: string;
  /** A Report was added: the sheet opens its tab. */
  onAdded: (reportId: string) => void;
}

export interface SheetSlots {
  anotherReport?: (props: AnotherReportSlotProps) => ReactNode;
  stackedHazard?: (props: StackedHazardSlotProps) => ReactNode;
  gpxImport?: (props: GpxImportSlotProps) => ReactNode;
  photoTileMenu?: (props: PhotoTileMenuSlotProps) => ReactNode;
  googlePhotos?: (props: GooglePhotosSlotProps) => ReactNode;
}

const SheetSlotsContext = createContext<SheetSlots>({});
/** The sheet's element, for a stacked flow to portal into. */
const SheetContainerContext = createContext<HTMLElement | null>(null);

export const SheetSlotsProvider = SheetSlotsContext.Provider;
export const SheetContainerProvider = SheetContainerContext.Provider;

export function useSheetSlots(): SheetSlots {
  return useContext(SheetSlotsContext);
}

export function useSheetContainer(): HTMLElement | null {
  return useContext(SheetContainerContext);
}

/**
 * Hazards' *Report a new hazard* (5.10): opens the hazard flow stacked over the report, which stays
 * as it is behind it. Records `hazard_flow_started` from the report sheet — the opener knows the
 * entry; the flow does not.
 */
export function ReportHazardButton({
  waterBodyId,
  reportId,
}: {
  waterBodyId: string;
  reportId: string;
}) {
  const { stackedHazard } = useSheetSlots();
  const container = useSheetContainer();
  const { capture } = useAnalytics();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              data-attr="report-hazard"
              data-mount="stacked-hazard"
              disabled={stackedHazard === undefined}
              className="self-start"
              onClick={() => {
                capture('hazard_flow_started', { entry: 'report_sheet' });
                setOpen(true);
              }}
            >
              <FontAwesomeIcon icon={faTriangleExclamation} />
              Report a new hazard
            </Button>
          }
        />
        <TooltipContent>
          Opens the hazard form over this report; the report stays as it is.
        </TooltipContent>
      </Tooltip>
      {open && stackedHazard
        ? stackedHazard({ waterBodyId, reportId, container, onClose: () => setOpen(false) })
        : null}
    </>
  );
}
