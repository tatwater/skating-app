import { isPassageMarker, type LatLng } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/kit/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/kit/dialog';
import { Kbd } from '@/components/kit/kbd';
import { MapModeBar } from '@/components/kit/map-controls';
import { cn } from '@/lib/utils';
import { useHazardDraftStore } from '@/stores/hazardDraftStore';
import { HazardFlow, type HazardFlowResult } from '../actions/HazardFlow';
import type { HazardFlowMapState } from '../actions/useHazardMap';
import { InstrumentMap } from './InstrumentMap';
import { InstrumentOverlay } from './InstrumentOverlay';
import type { InstrumentInput } from './instrumentFeatures';
import { holdInstrument } from './instrumentLease';
import { useSheetBody } from './useSheetBody';

export interface HazardSheetFrameProps {
  waterBodyId: string;
  subAreaId?: string;
  /**
   * Stacked inside the report sheet (5.10.1): portaled into the report's element, inset less than
   * the report is so its edges stay in sight, covering its header (Review 4); the report's own
   * instrument gives its GL context back while this one is open.
   */
  stacked?: boolean;
  /** The report sheet's element, when stacked. */
  container?: HTMLElement | null;
  /** Left by Close, Esc, Back or Cancel — the draft kept unless Cancel threw it away. */
  onClose: () => void;
  /** Filed or confirmed. Defaults to `onClose`. */
  onDone?: (result: HazardFlowResult) => void;
  /** Photos to start the hazard with (a report photo's *This is a hazard…*). */
  seedPhotos?: readonly File[];
}

/**
 * Report a hazard in **the New report sheet's frame** (B03 §5/§6; Review 2: "the map on the left,
 * only the hazard's questions on the right") — one composition for both doors:
 *
 * - **standalone** (`?act=hazard` on a lake): a sheet over the page, as the report sheet sits.
 * - **stacked** (5.10.1): inside the report, over its header, the report unchanged behind it.
 *
 * The left is an instrument of its own — **a short-lived MapLibre instance**, never the region map —
 * framed on the lake with its launches and live hazards; the flow's map state (J's `stacked`
 * contract) arrives through `onMapState`: the mode bar, the draft drawn over the map, the click
 * fed to the flow while it is placing. The right is J's flow, its questions only.
 *
 * **One Esc per screen**: the frame's dialog takes the first Esc (a nested dialog stacks above the
 * report's) and leaves through the flow's own way out, so the draft and the map's listening mode
 * end together. A sub-mode inside is left by a click.
 */
export function HazardSheetFrame({
  waterBodyId,
  subAreaId,
  stacked = false,
  container,
  onClose,
  onDone,
  seedPhotos,
}: HazardSheetFrameProps) {
  const body = useSheetBody(waterBodyId);
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [glMap, setGlMap] = useState<maplibregl.Map | null>(null);
  const [mapState, setMapState] = useState<HazardFlowMapState | null>(null);
  const instrument = useMemo(
    () => ({ map: glMap, loaded: glMap !== null, onMapState: setMapState }),
    [glMap],
  );

  // Stacked, this sheet's map replaces the report's while it's open: two GL contexts, never three.
  useEffect(() => (stacked ? holdInstrument() : undefined), [stacked]);

  // A seed lands once the flow's draft is this lake's (the flow resets a draft from another lake).
  const ready = useHazardDraftStore((s) => s.bound && s.draft?.waterBodyId === waterBodyId);
  const seeded = useRef(false);
  useEffect(() => {
    if (!ready || seeded.current || !seedPhotos || seedPhotos.length === 0) return;
    seeded.current = true;
    const store = useHazardDraftStore.getState();
    store.setPhotoFiles([...store.photoFiles, ...seedPhotos]);
  }, [ready, seedPhotos]);

  // Every way out runs once: the flow's leave (which closes this) and a direct close race on Esc.
  const exitRef = useRef<() => void>(onClose);
  exitRef.current = mapState?.onExitMode ?? onClose;

  const input: InstrumentInput = useMemo(
    () => ({
      polygon: body?.polygon ?? null,
      pins: [...(body?.putIns ?? []), ...(body?.parking ?? [])],
      hazards: (body?.hazards ?? []).map((h) => ({
        id: h.id,
        bbox: h.bbox,
        passage: isPassageMarker(h.type),
      })),
      photos: [],
    }),
    [body],
  );
  const onPick = (coord: LatLng) => {
    if (mapState?.capturing) mapState.onCapture(coord);
  };
  const name = body?.name ?? '';

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next && details.reason === 'escape-key') exitRef.current();
      }}
    >
      <DialogContent
        ref={setFrame}
        size="viewer"
        {...(stacked && container ? { container } : {})}
        data-slot="hazard-sheet"
        data-stacked={stacked ? '' : undefined}
        className={cn(
          'overflow-hidden bg-bg',
          stacked
            ? 'top-3.5 right-4.5 bottom-3.5 left-4.5'
            : 'top-18 right-8 bottom-5 left-8 max-md:inset-0',
        )}
      >
        <DialogTitle className="sr-only">Report a hazard</DialogTitle>
        <div className="flex size-full min-h-0 flex-col">
          <div
            data-slot="hazard-sheet-top"
            className="flex h-13 shrink-0 items-stretch border-0 border-b border-solid border-line pl-(--space-5_5)"
          >
            <span className="mr-(--space-5_5) self-center text-kick leading-none font-medium tracking-head text-fg2 uppercase">
              Report a hazard
            </span>
            <div className="relative flex items-center border-0 border-r border-solid border-line bg-panel px-(--space-4_5) after:absolute after:right-0 after:-bottom-px after:left-0 after:h-0.5 after:bg-fg">
              <span className="text-row font-semibold text-fg">{name}</span>
            </div>
            <div className="ml-auto flex items-center pr-(--space-3_5)">
              <Button size="sm" data-attr="hazard-sheet-close" onClick={() => exitRef.current()}>
                Close
                <Kbd variant="dim" aria-hidden="true">
                  Esc
                </Kbd>
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            <section
              aria-label="The lake"
              className="flex min-h-0 min-w-0 flex-1 flex-col border-0 border-r border-solid border-line"
            >
              <div className="flex h-14 shrink-0 items-center border-0 border-b border-solid border-line px-(--space-6)">
                <h2 className="m-0 text-disp leading-none font-semibold tracking-kick text-fg uppercase">
                  {name}
                </h2>
              </div>
              <div className="relative min-h-0 flex-1">
                {body?.polygon ? (
                  <InstrumentMap
                    input={input}
                    onPick={onPick}
                    onMap={setGlMap}
                    label={`${name}: where the hazard is`}
                    className={cn('absolute inset-0', mapState?.capturing && 'cursor-crosshair')}
                  >
                    <InstrumentOverlay
                      map={glMap}
                      mode={null}
                      silhouette={null}
                      pins={[]}
                      draft={mapState?.draft?.data ?? null}
                    />
                    {mapState?.mode ? (
                      <MapModeBar
                        mode={mapState.mode.mode}
                        step={mapState.mode.step}
                        onExit={mapState.onExitMode}
                        exitLabel="Leave the hazard form"
                      >
                        {mapState.mode.line}
                      </MapModeBar>
                    ) : null}
                  </InstrumentMap>
                ) : (
                  <p className="m-0 p-(--space-6) text-assist text-fg3">Drawing the lake…</p>
                )}
              </div>
            </section>
            <aside
              aria-label="The hazard"
              className="flex w-[29.25rem] shrink-0 flex-col overflow-y-auto px-(--space-6) pt-(--space-5_5) pb-(--space-6)"
            >
              <HazardFlow
                waterBodyId={waterBodyId}
                {...(subAreaId !== undefined ? { subAreaId } : {})}
                stacked={stacked}
                instrument={instrument}
                container={frame}
                onClose={onClose}
                {...(onDone !== undefined ? { onDone } : {})}
              />
            </aside>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
