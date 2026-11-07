import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  copernicusCredit,
  formatSeasonLabel,
  holdFrames,
  NO_HELD_FRAMES,
  prefetchFrames,
  type TimelineStop,
} from '@skating/core';
import { useQuery } from 'convex/react';
import type { MultiPolygon, Polygon } from 'geojson';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';

import { Note } from '@/components/kit/note';
import { Skeleton } from '@/components/kit/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { useAnalytics } from '@/lib/analytics';
import { env } from '@/lib/env';
import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { useFreezeUpFrame } from '../../useFreezeUpFrame';
import { useFreezeUpSeam } from '../../useFreezeUpSeam';
import { useFreezeUpTimeline } from '../../useFreezeUpTimeline';
import { defineMapSpec } from '../map/mapSpec';
import { useMapInstance, useMapSpec } from '../map/useMapSpec';
import { ImageryTimeline } from './ImageryTimeline';
import {
  ARCHIVE_BAND,
  buildImageryAxis,
  dayOf,
  type ImageryAxis,
  type ImageryUrlBand,
  selectedStopFor,
} from './imageryTicks';

/**
 * Latest imagery (boards 3.14/3.15): the lake's freeze-up timeline — Sentinel-2 true color or
 * Sentinel-1 radar — with the chosen pass painted over the lake (D146: imagery is body-scoped
 * content, the base map never changes). `?band=` and `?frame=` carry the view (D242); the frames
 * come from the archive (`env.imageryArchiveUrl`), never from the admin-only live lane.
 *
 * **Pictures, never verdicts** (D3, D147): the words say what each band can and can't tell apart,
 * and nothing reads a picture as "frozen" or "safe". Contours stand down while a picture is up (D81)
 * — declared in the flow spec — and hazards stay drawn: the map contract can't hide one.
 */

export const BAND_LABELS: Readonly<Record<ImageryUrlBand, string>> = {
  tc: 'Sentinel-2 true color',
  vh: 'Sentinel-1 radar (VH)',
};

export const BAND_HINTS: Readonly<Record<ImageryUrlBand, string>> = {
  tc: 'White may be snow, ice, or cloud — true color can’t tell them apart.',
  vh: 'Sees through cloud and darkness. Bright is rough or snow-covered ice; dark is smooth ice — or open water.',
};

/** The radar key's nine steps, black to white — a legend for the picture's own grays, not chrome. */
const RAMP = [6, 11, 20, 29, 40, 52, 65, 78, 91];

export type ImageryState =
  | { kind: 'unconfigured' }
  | { kind: 'error' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; axis: ImageryAxis; stops: readonly TimelineStop[]; selected: number | null };

export interface ImageryViewProps {
  band: ImageryUrlBand;
  season: string | null;
  state: ImageryState;
  onBand: (band: ImageryUrlBand) => void;
  onSelect: (index: number) => void;
}

export function ImageryView({ band, season, state, onBand, onSelect }: ImageryViewProps) {
  let body: ReactNode;
  switch (state.kind) {
    case 'unconfigured':
      body = <Note>Imagery isn’t available here yet.</Note>;
      break;
    case 'error':
      // A fact about the archive, never about the lake.
      body = <Note tone="warn">Couldn’t read the imagery archive. Try again later.</Note>;
      break;
    case 'loading':
      body = (
        <div aria-busy="true" className="flex flex-col gap-(--space-2_5)">
          <Skeleton className="h-[76px] w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      );
      break;
    case 'empty':
      body = <Note>No satellite passes recorded over this lake this season.</Note>;
      break;
    case 'ready':
      body = (
        <ImageryTimeline
          axis={state.axis}
          stops={state.stops}
          selected={state.selected}
          onSelect={onSelect}
        />
      );
      break;
  }
  return (
    <div data-slot="imagery-pane" data-band={band} className="flex flex-col gap-(--space-3_5)">
      <div className="flex items-baseline gap-(--space-3)">
        <h3 className="m-0 text-kick leading-none font-semibold tracking-kick text-fg uppercase">
          Freeze-up timeline
        </h3>
        {season !== null && (
          <span className="ms-auto font-(family-name:--family-mono) text-mono-sm text-fg2">
            {formatSeasonLabel(season)}
          </span>
        )}
      </div>
      {body}
      <ToggleGroup
        aria-label="Imagery band"
        value={band}
        onValueChange={(next) => onBand(next as ImageryUrlBand)}
        className="w-full"
      >
        {(['tc', 'vh'] as const).map((b) => (
          <ToggleGroupItem
            key={b}
            value={b}
            data-attr={`imagery-band-${b}`}
            // The board's sentence-case band names: they're instrument names, not commands.
            className="min-w-0 flex-1 px-(--space-2) text-assist font-regular tracking-normal normal-case"
          >
            {BAND_LABELS[b]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="m-0 text-assist text-fg2 [text-wrap:pretty]">{BAND_HINTS[band]}</p>
      {band === 'vh' && (
        <div data-slot="imagery-ramp" className="flex flex-col gap-(--space-1_5)">
          <span className="flex h-2 shadow-[inset_0_0_0_1px_var(--line2)]">
            {RAMP.map((l) => (
              <i key={l} className="flex-1" style={{ background: `hsl(0 0% ${l}%)` }} />
            ))}
          </span>
          <span className="flex justify-between text-assist text-fg2">
            <span>Smooth ice — or open water</span>
            <span>Rough or snow-covered ice</span>
          </span>
        </div>
      )}
      {season !== null && (
        <span className="border-0 border-t border-solid border-line pt-(--space-2_5) text-assist text-fg3">
          {copernicusCredit(season)}
        </span>
      )}
    </div>
  );
}

function polygonOf(geometry: unknown): Polygon | MultiPolygon | null {
  const type = (geometry as { type?: string } | null)?.type;
  return type === 'Polygon' || type === 'MultiPolygon'
    ? (geometry as Polygon | MultiPolygon)
    : null;
}

/** The view's spec while a picture is up: the lake's own, contours down (D81), no imagery button. */
export function imageryMapSpec(bodyId: string, subAreaId?: string) {
  return defineMapSpec({
    id: 'imagery',
    focus: subAreaId === undefined ? { bodyId } : { bodyId, subAreaId },
    layers: { depth: false, places: true, putIns: true, labels: true, favorites: true },
    fit: { kind: 'body', bodyId },
    dock: { zoom: true, layers: true },
  });
}

/**
 * The imagery view, connected. `band` / `frame` are the URL's; `onSearch` edits them (replace).
 */
export function ImageryPane({
  waterBodyId,
  subAreaId,
  band = 'tc',
  frame,
  onSearch,
}: {
  waterBodyId: string;
  subAreaId?: string;
  band?: ImageryUrlBand;
  frame?: string;
  onSearch: (edit: { band?: ImageryUrlBand | null; frame?: string | null }) => void;
}) {
  const { capture } = useAnalytics();
  const result = useQuery(api.waterBodies.get, { waterBodyId: waterBodyId as Id<'waterBodies'> });
  const body = result?.available ? result.body : null;
  const timeline = useFreezeUpTimeline({ body, band: ARCHIVE_BAND[band], enabled: true });
  const stops = timeline.timeline?.stops;
  const selected = useMemo(() => (stops ? selectedStopFor(stops, frame) : null), [stops, frame]);

  useMapSpec(
    useMemo(() => imageryMapSpec(waterBodyId, subAreaId), [waterBodyId, subAreaId]),
    { slot: 'flow' },
  );
  // The store's imagery switch, in memory only (a reveal is something you do, not a mode you live
  // in): the map reads it to stand contours down.
  useEffect(() => {
    const on = (imagery: boolean) =>
      useSkaterMapStore.setState((s) => ({ layers: { ...s.layers, imagery } }));
    on(true);
    return () => on(false);
  }, []);

  // The picture never goes away mid-scrub: a pass that isn't ready holds the last good frame.
  const [rendered, fold] = useReducer(holdFrames, NO_HELD_FRAMES);
  useLayoutEffect(() => {
    fold({ bodyId: waterBodyId, stops, selected, revealing: true });
  }, [waterBodyId, stops, selected]);

  const { map, loaded } = useMapInstance();
  const mapRef = useRef(map);
  mapRef.current = map;
  useFreezeUpFrame({
    mapRef,
    loaded,
    frame: rendered.primary?.frame ?? null,
    season: timeline.season,
  });
  useFreezeUpFrame({
    mapRef,
    loaded,
    frame: rendered.companion?.frame ?? null,
    season: timeline.season,
    slot: 'companion',
  });
  useFreezeUpSeam({
    mapRef,
    loaded,
    footprint: rendered.companion ? (rendered.primary?.frame.footprint ?? null) : null,
    body: polygonOf(body?.polygon ?? null),
  });

  // Warm the season's frames so scrubbing isn't a cold load per day.
  const frameKeys = (stops ?? []).map((s) => s.frame.key).join('|');
  useEffect(() => {
    if (!frameKeys || !env.imageryArchiveUrl) return;
    const controller = new AbortController();
    void prefetchFrames(env.imageryArchiveUrl, frameKeys.split('|'), controller.signal);
    return () => controller.abort();
  }, [frameKeys]);

  const state: ImageryState = !env.imageryArchiveUrl
    ? { kind: 'unconfigured' }
    : timeline.error
      ? { kind: 'error' }
      : !stops
        ? { kind: 'loading' }
        : stops.length === 0
          ? timeline.loading
            ? { kind: 'loading' }
            : { kind: 'empty' }
          : { kind: 'ready', axis: buildImageryAxis(stops, band), stops, selected };

  return (
    <ImageryView
      band={band}
      season={timeline.season}
      state={state}
      onBand={(next) => {
        if (next === band) return;
        capture('imagery_opened', { band: next });
        // The date travels across a band switch, so radar opens near the day you were looking at.
        const at =
          selected !== null && stops ? dayOf(stops[selected]?.frame.capturedAt ?? '') : null;
        onSearch({ band: next === 'tc' ? null : next, frame: at ?? frame ?? null });
      }}
      onSelect={(index) => {
        const day = stops ? dayOf(stops[index]?.frame.capturedAt ?? '') : null;
        if (day) onSearch({ frame: day });
      }}
    />
  );
}
