import type maplibregl from 'maplibre-gl';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { type MapSpecSlot, useSkaterMapStore } from '@/stores/skaterMapStore';
import type { MapSpec } from './mapSpec';

/**
 * How a view talks to the one persistent map (B03 §1.8): it declares a spec, and that's all.
 *
 * ```tsx
 * // /water/$id
 * useMapSpec(useMemo(() => lakeMapSpec(id, sub), [id, sub]), {
 *   onOpenImagery: () => navigate({ search: (s) => ({ ...s, act: 'imagery' }) }),
 * });
 * ```
 *
 * The spec holds from mount until unmount; on unmount the slot clears, so a view that leaves takes
 * its map with it. Two slots: a **view** (the route's page) and a **flow** over it (placing a hazard,
 * agent J) — the flow's spec wins while it's declared, and the view's comes back when it ends. Specs
 * are compared by what they'd draw, so passing a fresh object every render costs nothing.
 *
 * The handlers ride beside the spec rather than in it: a function can't be diffed, and the map reads
 * the latest ones at the moment a click lands.
 */
export interface MapSpecHandlers {
  /** A left-click while the spec's `interactions.click` is `capture`. */
  onCapture?: (coord: { lng: number; lat: number }) => void;
  /** The mode bar's Esc and its exit button. */
  onExitMode?: () => void;
  /** The dock's "Latest imagery". Without it the button doesn't show. */
  onOpenImagery?: () => void;
}

/**
 * Each slot's handlers, with the hook instance that set them. The owner matters on a route change:
 * the next view renders (and sets its handlers) before the last one's cleanup runs, so a cleanup may
 * only clear handlers it still owns.
 */
const handlersBySlot: Record<MapSpecSlot, { owner: object | null; handlers: MapSpecHandlers }> = {
  view: { owner: null, handlers: {} },
  flow: { owner: null, handlers: {} },
};

/** The handlers of whichever slot's spec is in force. Read by `SkaterMap` at event time. */
export function activeMapHandlers(): MapSpecHandlers {
  const { specs } = useSkaterMapStore.getState();
  if (specs.flow) return handlersBySlot.flow.handlers;
  return specs.view ? handlersBySlot.view.handlers : {};
}

export function useMapSpec(
  spec: MapSpec,
  options: MapSpecHandlers & { slot?: MapSpecSlot } = {},
): void {
  const { slot = 'view', ...handlers } = options;
  const declare = useSkaterMapStore((s) => s.declareMapSpec);
  const owner = useRef({}).current;
  // The latest handlers, without re-declaring the spec when only a closure changed.
  handlersBySlot[slot] = { owner, handlers };
  useEffect(() => {
    declare(slot, spec);
  }, [declare, slot, spec]);
  useEffect(
    () => () => {
      // Every unmount's cleanup runs before the next view's mount effects, so clearing the spec is
      // safe; the handlers were already replaced in the next view's render, so only clear our own.
      declare(slot, null);
      if (handlersBySlot[slot].owner === owner)
        handlersBySlot[slot] = { owner: null, handlers: {} };
    },
    [declare, slot, owner],
  );
}

// ── The instance, for the two tools that must own GL sources ──────────────────────────────────

/**
 * The live map, for an imperative tool that has to put its own sources on the canvas: terra-draw
 * (drawing a hazard area) and the imagery raster (`useImageryReveal`). **Nothing else** — layers,
 * framing and clicks are the spec's, or the map stops being diffable. A tool removes what it adds;
 * the instance changes on a theme switch (the map is re-created), and `loaded` drops while it does.
 */
interface MapInstanceSnapshot {
  map: maplibregl.Map | null;
  loaded: boolean;
}

let instance: MapInstanceSnapshot = { map: null, loaded: false };
const listeners = new Set<() => void>();

export function publishMapInstance(map: maplibregl.Map | null, loaded: boolean): void {
  if (instance.map === map && instance.loaded === loaded) return;
  instance = { map, loaded };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => instance;

export function useMapInstance(): MapInstanceSnapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/** The latest value of a prop, for handlers bound once. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
