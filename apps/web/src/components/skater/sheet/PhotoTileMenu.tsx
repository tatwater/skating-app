import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLocationCrosshairs,
  faTrashCan,
  faTriangleExclamation,
} from '@fortawesome/sharp-light-svg-icons';
import {
  assignCandidates,
  dropPhoto,
  movePhotoToReport,
  placePhotoByHand,
  reportEndMs,
  reportsInTimeOrder,
} from '@skating/core';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { useAnalytics } from '@/lib/analytics';
import { useBodyOutlines } from '@/lib/bodyOutlines';
import { releaseSheetPhoto, sheetPhotoBlob } from '@/lib/sheetPhotos';
import { updateSheet, useSheet } from '@/lib/sheetStore';
import { cn } from '@/lib/utils';
import { useConsoleMode } from './ConsoleMode';
import { StackedHazard } from './StackedHazard';
import { type PhotoTileMenuSlotProps, useSheetContainer } from './sheetSlots';

function clock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
    .format(ms)
    .replace(/\s?[AP]M$/, '');
}

/**
 * The `photoTileMenu` slot (5.19/5.20): a photo tile's corner mark opens *This photo is from* — a
 * row per Report, numbered as its tab, with its times — then *Place it on the lake* (the instrument
 * takes the click), *This is a hazard…* (the hazard sheet stacks over the report with this photo
 * in it; filed, the photo goes with the hazard and leaves the report), and *Leave it out*. The Post model has no cover photo,
 * so there is no "set as cover" here (a model change, not a menu one).
 */
export function PhotoTileMenu({ photo, reportId, trigger }: PhotoTileMenuSlotProps) {
  const post = useSheet();
  const outlines = useBodyOutlines();
  const { setMode, instrument } = useConsoleMode();
  const container = useSheetContainer();
  const { capture } = useAnalytics();
  const [hazard, setHazard] = useState<{
    waterBodyId: string;
    reportId: string;
    files: File[];
  } | null>(null);
  if (post === null) return <>{trigger}</>;
  const ordered = reportsInTimeOrder(post);
  const here = ordered.find((r) => r.id === reportId);
  const lake = here?.sheet.waterBodyId;

  const moveTo = (to: string) =>
    updateSheet((p) => movePhotoToReport(p, photo.id, to, assignCandidates(p, outlines)));
  const place = () => {
    if (reportId === null) return;
    setMode({
      kind: 'place',
      photoId: photo.id,
      onPlace: (coord) => {
        updateSheet((p) => placePhotoByHand(p, photo.id, coord));
        setMode(null);
      },
    });
  };
  const leaveOut = () => {
    updateSheet((p) => dropPhoto(p, photo.id));
    releaseSheetPhoto(photo.id);
  };
  const asHazard = () => {
    if (lake === undefined || reportId === null) return;
    const blob = sheetPhotoBlob(photo.fullUri);
    const files = blob ? [blob] : [];
    capture('hazard_flow_started', { entry: 'report_sheet' });
    // The photo leaves the report only once the hazard is filed with it; a hazard left unfiled
    // leaves the photo where it was.
    setHazard({ waterBodyId: lake, reportId, files });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-attr="photo-tile-menu"
          aria-label="This photo’s lake and options"
          render={<button type="button" />}
          className="absolute top-0 left-0 flex size-6 cursor-pointer items-start justify-start border-0 bg-transparent p-0 outline-none focus-visible:shadow-focus"
        >
          {trigger}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-65" {...(container !== null ? { container } : {})}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>This photo is from</DropdownMenuLabel>
            {ordered.map((r, i) => {
              const end = reportEndMs(r);
              const start = r.sheet.scalars.skateStartTime;
              const on = r.id === reportId;
              return (
                <DropdownMenuItem
                  key={r.id}
                  data-attr="photo-tile-lake"
                  label={r.bodyName ?? 'Which lake?'}
                  disabled={r.sheet.waterBodyId === undefined && r.coord === undefined}
                  className={cn(on && 'bg-lift-05 text-fg')}
                  icon={
                    <span className="flex size-4 items-center justify-center bg-fg1 font-(family-name:--family-mono) text-[0.625rem] text-bg">
                      {i + 1}
                    </span>
                  }
                  onClick={() => (on ? undefined : moveTo(r.id))}
                >
                  <span className="flex items-center gap-(--space-3)">
                    <span className="min-w-0 truncate">{r.bodyName ?? 'Which lake?'}</span>
                    {end !== undefined ? (
                      <span className="ml-auto font-(family-name:--family-mono) text-mono-sm text-fg2">
                        {start !== undefined ? `${clock(start)}–` : ''}
                        {clock(end)}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-attr="photo-tile-place"
            // Placing is a click on the instrument; a phone's sheet has none (row 9).
            disabled={reportId === null || lake === undefined || !instrument}
            icon={<FontAwesomeIcon icon={faLocationCrosshairs} />}
            onClick={place}
          >
            {instrument ? (
              'Place it on the lake'
            ) : (
              <span className="flex flex-col">
                Place it on the lake
                <span className="text-assist text-fg3">On a wider screen</span>
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-attr="photo-tile-hazard"
            disabled={reportId === null || lake === undefined}
            icon={<FontAwesomeIcon icon={faTriangleExclamation} />}
            onClick={asHazard}
          >
            This is a hazard…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-attr="photo-tile-leave-out"
            className="text-fg2"
            icon={<FontAwesomeIcon icon={faTrashCan} />}
            onClick={leaveOut}
          >
            Leave it out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {hazard !== null ? (
        <StackedHazard
          waterBodyId={hazard.waterBodyId}
          reportId={hazard.reportId}
          container={container}
          seedPhotos={hazard.files}
          onFiled={leaveOut}
          onClose={() => setHazard(null)}
        />
      ) : null}
    </>
  );
}
