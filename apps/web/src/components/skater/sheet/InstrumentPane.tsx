import { api } from '@skating/convex/api';
import {
  endTimeRow,
  isPassageMarker,
  type LatLng,
  reportEndMs,
  type SheetReport,
  selectedValues,
  sheetReducer,
  timelineFraction,
  timelineModel,
  updateReport,
} from '@skating/core';
import { useQuery } from 'convex/react';
import type maplibregl from 'maplibre-gl';
import { useCallback, useMemo, useState } from 'react';
import { updateSheet } from '@/lib/sheetStore';
import { useCoarsePointer } from '@/lib/useCoarsePointer';
import { cn } from '@/lib/utils';
import { useConsoleMode } from './ConsoleMode';
import { InstrumentMap } from './InstrumentMap';
import { InstrumentOverlay } from './InstrumentOverlay';
import type { InstrumentInput } from './instrumentFeatures';
import { useInstrumentHeld } from './instrumentLease';
import { pickOnInstrument } from './instrumentPick';
import { mapProjection } from './instrumentProjection';
import { offeredEndChips } from './reportCalendar';
import { Timeline } from './Timeline';
import type { SheetBody } from './useSheetBody';
import { useSkateWeather, useSkateWindowHours } from './useSkateWeather';
import { WeatherBand } from './WeatherBand';

/**
 * The left pane (5.1): the lake on its own map, the day's ruler under it, the weather you had under
 * that. In a sub-mode (where, put-in, placing a photo) the header becomes the question, the map takes
 * the click, and the ruler and weather step back; a sub-mode is left by a click (Done), never Esc —
 * Esc is the sheet's (one Esc per screen).
 */
export function InstrumentPane({
  report,
  ordered,
  body,
  inert,
}: {
  report: SheetReport;
  /** The Post's Reports in time order, numbered as their tabs are. */
  ordered: readonly SheetReport[];
  body: SheetBody | null;
  /** Posting, or a sent Post: shown, not offered. */
  inert: boolean;
}) {
  const { mode, exit } = useConsoleMode();
  const held = useInstrumentHeld();
  const [glMap, setGlMap] = useState<maplibregl.Map | null>(null);
  const sheet = report.sheet;
  const timeZone = body?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [end] = selectedValues(sheet, 'endTime');
  const endMs = end?.ms;
  const startMs = sheet.scalars.skateStartTime;
  const gps = end?.precision === 'gps';
  const dispatch = useCallback(
    (action: Parameters<typeof sheetReducer>[1]) =>
      updateSheet((p) =>
        updateReport(p, report.id, (r) => ({ ...r, sheet: sheetReducer(r.sheet, action) })),
      ),
    [report.id],
  );

  const hours = useSkateWeather(body?.waterBodyId, endMs, timeZone);
  const windowHours = useSkateWindowHours(hours, endMs, startMs);
  const [now] = useState(() => Date.now());
  const sun = useMemo(() => body?.sunAt(endMs ?? now) ?? null, [body, endMs, now]);
  // D192's ladder as the ruler's ticks — the When panel's chips are the same instants for a
  // keyboard, so the ticks are the same `offeredEndChips` cut (founder, 2026-11-07).
  const mobile = useCoarsePointer();
  const ladder = useMemo(() => {
    if (gps) return [];
    const chips = endTimeRow({
      openedAtMs: sheet.openedAtMs,
      nowMs: now,
      timeZone,
      sun: body?.sunAt(sheet.openedAtMs) ?? null,
    }).chips;
    return offeredEndChips(chips, mobile).map((c) => ({ ms: c.ms, pinned: c.pinned }));
  }, [gps, sheet.openedAtMs, now, timeZone, body, mobile]);
  const model = useMemo(() => {
    const others = ordered.flatMap((r, i) => {
      const e = r.id === report.id ? undefined : reportEndMs(r);
      if (e === undefined) return [];
      return [
        {
          id: r.id,
          label: `${i + 1} · ${(r.bodyName ?? 'lake').toUpperCase()}`,
          ...(r.sheet.scalars.skateStartTime !== undefined
            ? { startMs: r.sheet.scalars.skateStartTime }
            : {}),
          endMs: e,
        },
      ];
    });
    return timelineModel({
      timeZone,
      nowMs: now,
      ...(endMs !== undefined ? { endMs } : {}),
      ...(startMs !== undefined ? { startMs } : {}),
      sun,
      others,
      ladder,
    });
  }, [ordered, report.id, timeZone, now, endMs, startMs, sun, ladder]);

  // The linked track, when a server activity is attached (an import, an unreported skate).
  const mine = useQuery(api.gpsActivities.listMine, report.activityId !== undefined ? {} : 'skip');
  const track = useMemo(() => {
    const path = mine?.find((a) => a.activityId === report.activityId)?.path;
    return path?.type === 'LineString' ? (path.coordinates as number[][]) : undefined;
  }, [mine, report.activityId]);

  const input: InstrumentInput = useMemo(
    () => ({
      polygon: body?.polygon ?? null,
      pins: [...(body?.putIns ?? []), ...(body?.parking ?? [])],
      ...(sheet.scalars.putInId !== undefined || sheet.scalars.parkingAreaId !== undefined
        ? { chosenPinId: sheet.scalars.putInId ?? sheet.scalars.parkingAreaId }
        : {}),
      hazards: mode
        ? []
        : (body?.hazards ?? []).map((h) => ({
            id: h.id,
            bbox: h.bbox,
            passage: isPassageMarker(h.type),
            ...(h.healing ? { healing: true } : {}),
          })),
      photos: report.photos.flatMap((p) =>
        p.placeOnMap && p.coord !== undefined ? [{ id: p.id, coord: p.coord }] : [],
      ),
      ...(track !== undefined ? { track } : {}),
      ...(sheet.scalars.point !== undefined ? { point: sheet.scalars.point } : {}),
    }),
    [body, sheet.scalars, mode, report.photos, track],
  );

  // A sub-mode's answer is a click on the water (`pickOnInstrument`: the ring's sectors, a snap to
  // a launch, a point).
  const onPick = (coord: LatLng) =>
    pickOnInstrument(mode, coord, {
      ...(glMap !== null ? { projection: mapProjection(glMap) } : {}),
      origin: body?.silhouette?.origin ?? null,
      pins: input.pins,
      landmarks: body?.landmarks ?? [],
    });

  const name = report.bodyName ?? body?.name ?? 'This lake';
  const question =
    mode?.kind === 'where'
      ? {
          t: `Where is the ${mode.label.toLowerCase()}?`,
          s: 'Click a sector, a bay, or a point on the water',
        }
      : mode?.kind === 'place'
        ? { t: 'Where was this photo taken?', s: 'Click the water where you took it' }
        : mode?.kind === 'putIn'
          ? { t: 'Where did you get on?', s: 'Click a launch, or the shore for somewhere else' }
          : null;

  return (
    <section
      data-slot="instrument"
      aria-label="The lake and the day"
      inert={inert}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col border-0 border-r border-solid border-line',
        inert && 'opacity-50',
      )}
    >
      {question ? (
        <div
          data-slot="instrument-mode"
          className="flex items-center gap-(--space-3) px-(--space-6) pt-(--space-4_5)"
        >
          <i aria-hidden className="size-2 bg-acc" />
          <span className="text-kick leading-none font-semibold tracking-head text-fg uppercase">
            {question.t}
          </span>
          <span className="text-assist text-fg2">{question.s}</span>
          <button
            type="button"
            data-attr="instrument-mode-done"
            onClick={exit}
            className="ml-auto h-btn-xs cursor-pointer rounded-control border-0 bg-inv-bg px-(--space-3) text-kick font-semibold tracking-head text-inv-fg uppercase outline-none focus-visible:shadow-focus"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-(--space-3_5) px-(--space-6) pt-(--space-4_5)">
          <h2 className="m-0 text-disp leading-none font-semibold tracking-kick text-fg uppercase">
            {name}
          </h2>
        </div>
      )}
      <div className="relative mx-(--space-6) mt-(--space-1_5) min-h-0 flex-1">
        {body?.polygon ? (
          <InstrumentMap
            input={input}
            onPick={onPick}
            onMap={setGlMap}
            suspended={held}
            keyDim={mode !== null}
            label={`${name}, with your put-in and any photos you placed`}
            className="absolute inset-0"
          >
            <InstrumentOverlay
              map={held ? null : glMap}
              mode={mode}
              silhouette={body?.silhouette ?? null}
              marks={input}
            />
          </InstrumentMap>
        ) : (
          <p className="m-0 pt-(--space-6) text-assist text-fg3">Drawing the lake…</p>
        )}
      </div>
      <div className={cn('border-0 border-t border-solid border-line', mode && 'opacity-30')}>
        <Timeline
          model={model}
          dim={mode !== null}
          endLocked={gps}
          {...(!gps
            ? {
                onSetEnd: (ms: number) =>
                  dispatch({
                    type: 'select',
                    field: 'endTime',
                    key: 'chosen',
                    value: { ms, precision: 'minute' },
                  }),
                onSetStart: (ms: number) =>
                  dispatch({ type: 'setScalar', key: 'skateStartTime', value: ms }),
              }
            : {})}
        />
      </div>
      <div className={cn(mode && 'opacity-30')}>
        <WeatherBand
          hours={hours}
          windowHours={windowHours}
          endMs={endMs}
          timeZone={timeZone}
          sun={sun}
          fractionOf={(ms) => timelineFraction(model, ms)}
          report={report}
          dispatch={dispatch}
          dim={mode !== null}
        />
      </div>
    </section>
  );
}
