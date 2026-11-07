/**
 * The map spec: what one view asks of the one persistent region map (B03 §1.8).
 *
 * `SkaterMap` is never unmounted across `/`, `/water/$id`, the panels and Latest's `?view=map`, so
 * nothing about a view may outlive it by accident. A view states the *whole* of what it wants — a
 * field it leaves out takes the default here, never the last view's value — and `SkaterMap` diffs
 * the old spec against the new one and applies only the difference. That is what "no view inherits
 * the last view's layers" means in code, and `diffMapSpec` / `applyMapSpecOps` are pure so it can be
 * proven rather than hoped (`mapSpec.test.ts`).
 *
 * **Hazards are not a field.** A focused lake always draws its hazards (the layers menu shows the
 * row locked on, board 3.16): no spec and no toggle can hide one, so "the app quietly stopped drawing
 * the warning" isn't a state this type can express (D3).
 */

/** The layers a view can ask for. Hazards are deliberately absent: see the module note. */
export const SPEC_LAYERS = ['depth', 'places', 'putIns', 'tracks', 'labels', 'favorites'] as const;
export type SpecLayer = (typeof SPEC_LAYERS)[number];
export type SpecLayers = Readonly<Record<SpecLayer, boolean>>;

/**
 * What a left-click on the map does.
 * - `navigate`: a hazard opens `/hazard/$id`, a listed body `/water/$id` (`interactions.select`).
 * - `capture`: the coordinate goes to the declaring view's `onCapture`; nothing navigates.
 * - `none`: the map takes no click at all.
 */
export type MapClickMode = 'navigate' | 'capture' | 'none';

export interface MapInteractions {
  pan: boolean;
  zoom: boolean;
  /** A click on a listed body or hazard opens it. Only read when `click` is `navigate`. */
  select: boolean;
  /** A click on unlisted water sets the store's `pendingMapClick` (the request-a-lake flow). */
  requestLake: boolean;
  click: MapClickMode;
}

/** The dock's controls this view shows (boards 1.1, 1.2, 3.16). Return-to-region isn't one: it follows the camera. */
export const DOCK_CONTROLS = ['zoom', 'layers', 'locate', 'imagery', 'legend'] as const;
export type DockControl = (typeof DOCK_CONTROLS)[number];
export type DockControls = Readonly<Record<DockControl, boolean>>;

/**
 * What to frame. `null` leaves the camera where the skater put it. **A fit runs once per `key`**: the
 * same fit in the next spec does nothing, so a re-render never undoes a pan; a new key frames again.
 */
export type MapFit =
  /** A body, resolved by `SkaterMap` from its own focus read (a deep link has no bbox to pass). */
  | { kind: 'body'; bodyId: string }
  | { kind: 'bounds'; key: string; bounds: [[number, number], [number, number]] }
  | { kind: 'point'; key: string; lng: number; lat: number; zoom?: number }
  /** The five-state framing. */
  | { kind: 'region' };

/** The fit's identity: what `diffMapSpec` compares, so a fit runs once per key. */
export function fitKey(fit: MapFit | null): string | null {
  if (fit === null) return null;
  switch (fit.kind) {
    case 'body':
      return `body:${fit.bodyId}`;
    case 'region':
      return 'region';
    case 'bounds':
    case 'point':
      return `${fit.kind}:${fit.key}`;
  }
}

/** The lake a view is about: drives selection, its hazards, put-ins, places, depth and tracks. */
export interface MapFocus {
  bodyId: string;
  /** A bay framed inside the lake (`?sub=`, board 1.10). */
  subAreaId?: string;
  /** The hazard an inset card is open on: brackets on its mark, the others recede (board 2.1). */
  hazardId?: string;
}

/** Geometry a view draws for itself. Compared by `key`, because comparing GeoJSON per render isn't free. */
export interface MapOverlay {
  key: string;
  data: GeoJSON.FeatureCollection;
}

/**
 * - `track`: one report's own path, over the lake's aggregate (a line).
 * - `photos`: a report's photo pins (points).
 * - `draft`: the hazard being authored — `hazardDraftToFeatureCollection`'s shape.
 */
export const MAP_OVERLAYS = ['track', 'photos', 'draft'] as const;
export type MapOverlayName = (typeof MAP_OVERLAYS)[number];
export type MapOverlays = Readonly<Record<MapOverlayName, MapOverlay | null>>;

/** A transient mode's bar (the kit's `MapModeBar`). Its exit is the declaring view's `onExitMode`. */
export interface MapMode {
  mode: string;
  line?: string;
  step?: string;
}

export interface MapSpec {
  /** Names the declaring view — a debugging aid on the pane's `data-map-spec`, never logic. */
  id: string;
  /** False: the pane hides and every map read is skipped. A page that declares nothing gets this. */
  visible: boolean;
  focus: MapFocus | null;
  layers: SpecLayers;
  interactions: MapInteractions;
  fit: MapFit | null;
  overlays: MapOverlays;
  mode: MapMode | null;
  dock: DockControls;
}

/** What a view passes: anything unstated takes the default below, never the previous view's value. */
export type MapSpecInput = Partial<
  Omit<MapSpec, 'layers' | 'interactions' | 'overlays' | 'dock'>
> & {
  id: string;
  layers?: Partial<SpecLayers>;
  interactions?: Partial<MapInteractions>;
  overlays?: Partial<MapOverlays>;
  dock?: Partial<DockControls>;
};

const NO_LAYERS: SpecLayers = {
  depth: false,
  places: false,
  putIns: false,
  tracks: false,
  labels: false,
  favorites: false,
};

const NO_OVERLAYS: MapOverlays = { track: null, photos: null, draft: null };

const DEFAULT_INTERACTIONS: MapInteractions = {
  pan: true,
  zoom: true,
  select: true,
  requestLake: false,
  click: 'navigate',
};

const NO_DOCK: DockControls = {
  zoom: false,
  layers: false,
  locate: false,
  imagery: false,
  legend: false,
};

/** The spec with every default stated. */
export function defineMapSpec(input: MapSpecInput): MapSpec {
  return {
    id: input.id,
    visible: input.visible ?? true,
    focus: input.focus ?? null,
    layers: { ...NO_LAYERS, ...input.layers },
    interactions: { ...DEFAULT_INTERACTIONS, ...input.interactions },
    fit: input.fit ?? null,
    overlays: { ...NO_OVERLAYS, ...input.overlays },
    mode: input.mode ?? null,
    dock: { ...NO_DOCK, ...input.dock },
  };
}

/**
 * The spec in force when no view has declared one: no map at all. A page that knows nothing about
 * the map (Settings, a profile) gets a hidden pane and no reads, rather than the last view's map.
 */
export const HIDDEN_MAP_SPEC: MapSpec = defineMapSpec({
  id: 'hidden',
  visible: false,
  interactions: { pan: false, zoom: false, select: false, click: 'none' },
});

// ── The views' specs ──────────────────────────────────────────────────────────────────────────

const ALL_LAYERS: SpecLayers = {
  depth: true,
  places: true,
  putIns: true,
  tracks: true,
  labels: true,
  favorites: true,
};

/** `/`: nothing chosen — the lakes in view, labeled (board 1.1). */
export function exploreMapSpec(): MapSpec {
  return defineMapSpec({
    id: 'explore',
    layers: { labels: true, favorites: true },
    interactions: { requestLake: true },
    dock: { zoom: true, layers: true, locate: true },
  });
}

/** `/water/$id`: one lake, framed — depth, hazards, put-ins, places (board 1.2). */
export function lakeMapSpec(bodyId: string, subAreaId?: string): MapSpec {
  return defineMapSpec({
    id: 'lake',
    focus: subAreaId === undefined ? { bodyId } : { bodyId, subAreaId },
    layers: ALL_LAYERS,
    interactions: { requestLake: true },
    fit: { kind: 'body', bodyId },
    dock: { zoom: true, layers: true, imagery: true, legend: true },
  });
}

/**
 * `/report|hazard|bounty/$id`: an inset card over its lake's sidebar (rows 2). Same map as the lake,
 * and the fit has the lake's own key, so opening a card from the lake doesn't move the camera. A
 * card about a bay (a bay's bounty) passes `subAreaId`, which selects the bay and scrims the rest of
 * the lake exactly as the lake's `?sub=` does — still under the lake's fit key, so the camera fits
 * once per lake.
 */
export function panelMapSpec(
  bodyId: string,
  options: {
    subAreaId?: string;
    hazardId?: string;
    track?: MapOverlay | null;
    photos?: MapOverlay | null;
  } = {},
): MapSpec {
  const { subAreaId, hazardId, track = null, photos = null } = options;
  return defineMapSpec({
    id: 'panel',
    focus: {
      bodyId,
      ...(subAreaId !== undefined ? { subAreaId } : {}),
      ...(hazardId !== undefined ? { hazardId } : {}),
    },
    layers: ALL_LAYERS,
    fit: { kind: 'body', bodyId },
    overlays: { track, photos },
    dock: { zoom: true, layers: true, imagery: true, legend: true },
  });
}

/** Latest's `?view=map` (board 4.4): the lakes in view, labeled; a click opens the lake. */
export function latestMapSpec(): MapSpec {
  return defineMapSpec({
    id: 'latest',
    layers: { labels: true, favorites: true },
    dock: { zoom: true, layers: true, locate: true },
  });
}

// ── What the viewer's own switches change ─────────────────────────────────────────────────────

/** The layers menu's switches: a view says what it can draw, the viewer can turn that down. */
export type LayerToggles = Readonly<Record<SpecLayer | 'imagery', boolean>>;

/**
 * A spec with the viewer's switches applied: a layer draws only if the view asks for it *and* the
 * viewer hasn't turned it off. A switch can't conjure a layer the view left out, and contours stand
 * down while imagery is on (D81).
 */
export function resolveMapSpec(spec: MapSpec, toggles: LayerToggles): MapSpec {
  const layers = Object.fromEntries(
    SPEC_LAYERS.map((layer) => [layer, spec.layers[layer] && toggles[layer]]),
  ) as Record<SpecLayer, boolean>;
  if (toggles.imagery) layers.depth = false;
  return { ...spec, layers };
}

// ── The differ ────────────────────────────────────────────────────────────────────────────────

export type MapSpecOp =
  | { kind: 'id'; id: string }
  | { kind: 'visible'; visible: boolean }
  | { kind: 'focus'; focus: MapFocus | null }
  | { kind: 'layer'; layer: SpecLayer; on: boolean }
  | { kind: 'interaction'; interactions: MapInteractions }
  | { kind: 'fit'; fit: MapFit | null }
  | { kind: 'overlay'; name: MapOverlayName; overlay: MapOverlay | null }
  | { kind: 'mode'; mode: MapMode | null }
  | { kind: 'dock'; control: DockControl; on: boolean };

function sameFocus(a: MapFocus | null, b: MapFocus | null): boolean {
  return a?.bodyId === b?.bodyId && a?.subAreaId === b?.subAreaId && a?.hazardId === b?.hazardId;
}

function sameInteractions(a: MapInteractions, b: MapInteractions): boolean {
  return (
    a.pan === b.pan &&
    a.zoom === b.zoom &&
    a.select === b.select &&
    a.requestLake === b.requestLake &&
    a.click === b.click
  );
}

function sameMode(a: MapMode | null, b: MapMode | null): boolean {
  return a?.mode === b?.mode && a?.line === b?.line && a?.step === b?.step;
}

/**
 * The operations that take the map from `prev` to `next`, or from nothing when `prev` is `null` — a
 * new instance (first load, or the theme's re-create) has none of the spec applied, so everything
 * comes through. Equal specs yield no operations at all, which is what makes applying on every
 * render free.
 */
export function diffMapSpec(prev: MapSpec | null, next: MapSpec): MapSpecOp[] {
  const ops: MapSpecOp[] = [];
  if (prev?.id !== next.id) ops.push({ kind: 'id', id: next.id });
  if (prev?.visible !== next.visible) ops.push({ kind: 'visible', visible: next.visible });
  if (!prev || !sameFocus(prev.focus, next.focus)) ops.push({ kind: 'focus', focus: next.focus });
  for (const layer of SPEC_LAYERS) {
    if (prev?.layers[layer] !== next.layers[layer]) {
      ops.push({ kind: 'layer', layer, on: next.layers[layer] });
    }
  }
  if (!prev || !sameInteractions(prev.interactions, next.interactions)) {
    ops.push({ kind: 'interaction', interactions: next.interactions });
  }
  if (!prev || fitKey(prev.fit) !== fitKey(next.fit)) ops.push({ kind: 'fit', fit: next.fit });
  for (const name of MAP_OVERLAYS) {
    const overlay = next.overlays[name];
    if (!prev || prev.overlays[name]?.key !== overlay?.key) {
      ops.push({ kind: 'overlay', name, overlay });
    }
  }
  if (!prev || !sameMode(prev.mode, next.mode)) ops.push({ kind: 'mode', mode: next.mode });
  for (const control of DOCK_CONTROLS) {
    if (prev?.dock[control] !== next.dock[control]) {
      ops.push({ kind: 'dock', control, on: next.dock[control] });
    }
  }
  return ops;
}

/** Applies operations to a spec. The differ's other half: `apply(prev, diff(prev, next))` is `next`. */
export function applyMapSpecOps(base: MapSpec, ops: readonly MapSpecOp[]): MapSpec {
  let spec = base;
  for (const op of ops) {
    switch (op.kind) {
      case 'id':
        spec = { ...spec, id: op.id };
        break;
      case 'visible':
        spec = { ...spec, visible: op.visible };
        break;
      case 'focus':
        spec = { ...spec, focus: op.focus };
        break;
      case 'layer':
        spec = { ...spec, layers: { ...spec.layers, [op.layer]: op.on } };
        break;
      case 'interaction':
        spec = { ...spec, interactions: op.interactions };
        break;
      case 'fit':
        spec = { ...spec, fit: op.fit };
        break;
      case 'overlay':
        spec = { ...spec, overlays: { ...spec.overlays, [op.name]: op.overlay } };
        break;
      case 'mode':
        spec = { ...spec, mode: op.mode };
        break;
      case 'dock':
        spec = { ...spec, dock: { ...spec.dock, [op.control]: op.on } };
        break;
    }
  }
  return spec;
}

/** Whether two specs would draw the same map: the store keeps the old object when they would. */
export function sameMapSpec(a: MapSpec, b: MapSpec): boolean {
  return diffMapSpec(a, b).length === 0;
}

// ── What a click means ────────────────────────────────────────────────────────────────────────

/** What the click hit. `onUnlistedWater` is the basemap's water with no listed body over it. */
export interface MapClickHit {
  hazardId?: string;
  bodyId?: string;
  onUnlistedWater: boolean;
}

export type MapClickAction =
  | { kind: 'none' }
  | { kind: 'capture' }
  | { kind: 'hazard'; hazardId: string }
  | { kind: 'body'; bodyId: string }
  | { kind: 'request' };

/**
 * A left-click's meaning under a spec, in the order the map has always resolved it: a hazard lies
 * inside its lake, so the more specific and more safety-relevant target wins.
 */
export function mapClickAction(interactions: MapInteractions, hit: MapClickHit): MapClickAction {
  if (interactions.click === 'none') return { kind: 'none' };
  if (interactions.click === 'capture') return { kind: 'capture' };
  if (interactions.select && hit.hazardId !== undefined) {
    return { kind: 'hazard', hazardId: hit.hazardId };
  }
  if (interactions.select && hit.bodyId !== undefined) {
    return { kind: 'body', bodyId: hit.bodyId };
  }
  if (interactions.requestLake && hit.bodyId === undefined && hit.onUnlistedWater) {
    return { kind: 'request' };
  }
  return { kind: 'none' };
}
