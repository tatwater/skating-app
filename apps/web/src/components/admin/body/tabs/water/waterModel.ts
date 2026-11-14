import {
  DEFAULT_SAMPLE_SPACING_KM,
  DEPTH_SOURCE_LABELS,
  DEPTH_SOURCE_RANK,
  type DepthSource,
  isMeasuredDepthSource,
  spansMultipleSampleCells,
} from '@skating/core';

import type { BodyMapScene, MapItem } from '../../map/mapDescriptors';
import { FAILED, type Loaded } from '../places/useTabReads';

type LatLng = { lat: number; lng: number };

/**
 * The Water tab's data: depth as a ladder of sources (each offering a mean, a max or both, the one
 * in use wearing Now), where the weather is sampled and why there, and the bathymetry state. Pure.
 * `null` means not recorded — said so, never zero; a part read on its own is in its read's state
 * ({@link Loaded}).
 */

export type BBox = { minLat: number; minLng: number; maxLat: number; maxLng: number };

/** One source's offer: its mean and max, where it has them. */
export type DepthRung = {
  source: DepthSource;
  mean: number | null;
  max: number | null;
};

export type Depth = {
  rungs: DepthRung[];
  /** The source each measurement uses now; `null` with none on record. */
  meanFrom: DepthSource | null;
  maxFrom: DepthSource | null;
  /**
   * Whether the other sources' offers are on the ladder. The depth loader keeps only each
   * measurement's winner, so this is `null` (not recorded) until the candidates are stored; `kept`
   * once they are (the board's).
   */
  others: 'kept' | null;
};

export type Sampling = {
  /** The interior point every body samples at by default; `null` until derived. */
  interior: LatLng | null;
  /** Points a moderator set by hand, replacing the default; `null` when there are none. */
  points: LatLng[] | null;
  /** How far the body spans, the longer of its box's two sides, in km. */
  acrossKm: number | null;
  /** Wider than the forecast models resolve: more than one point is worth having. */
  wide: boolean;
};

export type Bathymetry = {
  /** What was searched for this body, and when; `null` when no read records it. */
  searched: { source: string; when: string } | null;
  /** What was found. */
  found: string;
  /** No contour lines: the record wants finishing. */
  missing: boolean;
};

export type WaterData = {
  name: string;
  /** The body's (first) state, for a state survey's name. */
  state: string | null;
  depth: Depth;
  sampling: Sampling;
  /** The bathymetry state, in its read's state (`bodyConsole.consoleExtras`). */
  bathymetry: Loaded<Bathymetry>;
  box: BBox | null;
  /** What couldn't be read, in words ("the bathymetry state"). */
  failures: string[];
};

/** What the model reads off the body's record. */
export type WaterBody = {
  name: string;
  states?: readonly string[];
  meanDepthM?: number;
  maxDepthM?: number;
  meanDepthSource?: DepthSource;
  maxDepthSource?: DepthSource;
  interiorPoint?: LatLng;
  weatherSamplePoints?: readonly LatLng[];
  bbox?: BBox;
};

/**
 * The ladder from the record. The record keeps only each measurement's winner, so today's ladder is
 * one rung per source in use (two when mean and max came from different sources); the other
 * sources' offers arrive with the candidates read (`extra`), best first.
 */
export function depthOf(body: WaterBody, extra: readonly DepthRung[] = []): Depth {
  const rungs = new Map<DepthSource, DepthRung>();
  for (const r of extra) rungs.set(r.source, { ...r });
  const put = (source: DepthSource | undefined, key: 'mean' | 'max', value: number | undefined) => {
    if (source === undefined || value === undefined) return;
    const rung = rungs.get(source) ?? { source, mean: null, max: null };
    rung[key] = value;
    rungs.set(source, rung);
  };
  put(body.meanDepthSource, 'mean', body.meanDepthM);
  put(body.maxDepthSource, 'max', body.maxDepthM);
  return {
    rungs: [...rungs.values()]
      .filter((r) => r.mean !== null || r.max !== null)
      .sort((a, b) => DEPTH_SOURCE_RANK[a.source] - DEPTH_SOURCE_RANK[b.source]),
    meanFrom: body.meanDepthM !== undefined ? (body.meanDepthSource ?? null) : null,
    maxFrom: body.maxDepthM !== undefined ? (body.maxDepthSource ?? null) : null,
    others: extra.length > 0 ? 'kept' : null,
  };
}

/**
 * The bathymetry state from whether contours were drawn for the body (`consoleExtras`). What was
 * searched, and when, no read records yet.
 */
export function bathymetryOf(hasBathymetry: boolean): Bathymetry {
  return hasBathymetry
    ? { searched: null, found: 'Contour lines drawn', missing: false }
    : { searched: null, found: 'No contour lines', missing: true };
}

/** A source's name on the ladder, and the line under it when the name alone would mislead. */
export function sourceWords(
  source: DepthSource,
  state: string | null,
): { name: string; note: string | null } {
  switch (source) {
    case 'state_agency':
      return { name: state ? `${state} state survey` : 'State survey', note: null };
    case 'hydrolakes_modeled':
      return { name: 'HydroLAKES', note: 'Modeled · an estimate' };
    case 'hydrolakes_reported':
      return { name: 'HydroLAKES', note: 'From its reported volume' };
    case 'globathy':
      return { name: 'GLOBathy', note: 'Modeled · an estimate' };
    case 'operator':
      return { name: 'A moderator', note: 'Entered by hand' };
    default: {
      const label = DEPTH_SOURCE_LABELS[source];
      return { name: label.charAt(0).toUpperCase() + label.slice(1), note: null };
    }
  }
}

/** A modeled number reads as an estimate ("~8.1"). */
export const isEstimate = (source: DepthSource) => !isMeasuredDepthSource(source);

/** Meters to one decimal under 10, whole above — as the board writes them. */
export function depthFigure(m: number): string {
  return m < 10 ? m.toFixed(1) : String(Math.round(m));
}

const M_PER_DEG_LAT = 111_320;

/** The longer side of a box, in km, measured the way `spansMultipleSampleCells` does. */
export function acrossKm(box: BBox): number {
  const lat = (box.maxLat - box.minLat) * M_PER_DEG_LAT;
  const worst = Math.max(Math.abs(box.minLat), Math.abs(box.maxLat));
  const lng = (box.maxLng - box.minLng) * M_PER_DEG_LAT * Math.cos((worst * Math.PI) / 180);
  return Math.max(lat, lng) / 1000;
}

/** The box's two spans, east–west then north–south, in km to a tenth. */
export function spansKm(box: BBox): { ew: number; ns: number } {
  const ns = ((box.maxLat - box.minLat) * M_PER_DEG_LAT) / 1000;
  const ew =
    ((box.maxLng - box.minLng) * M_PER_DEG_LAT * Math.cos((box.maxLat * Math.PI) / 180)) / 1000;
  return { ew, ns };
}

export function waterFrom(
  body: WaterBody,
  // Required, never defaulted: a default would read the extras still loading as landed.
  extrasRead: Loaded<{ hasBathymetry: boolean }>,
  extras: { candidates?: readonly DepthRung[] } = {},
): WaterData {
  const box = body.bbox ?? null;
  const bathymetry: Loaded<Bathymetry> =
    extrasRead === undefined || extrasRead === FAILED
      ? extrasRead
      : bathymetryOf(extrasRead.hasBathymetry);
  return {
    name: body.name,
    state: body.states?.[0] ?? null,
    depth: depthOf(body, extras.candidates),
    sampling: {
      interior: body.interiorPoint ?? null,
      points:
        body.weatherSamplePoints && body.weatherSamplePoints.length > 0
          ? [...body.weatherSamplePoints]
          : null,
      acrossKm: box ? acrossKm(box) : null,
      wide: box ? spansMultipleSampleCells(box) : false,
    },
    bathymetry,
    box,
    failures: extrasRead === FAILED ? ['the bathymetry state'] : [],
  };
}

/** A point as the board writes it: four decimals, hemisphere letters. */
export function formatLatLng(p: LatLng): string {
  const lat = `${Math.abs(p.lat).toFixed(4)}°${p.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(p.lng).toFixed(4)}°${p.lng >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lng}`;
}

/** Why the body has the points it has, in a sentence. */
export function samplingNote(name: string, sampling: Sampling): string | null {
  if (sampling.acrossKm === null) return null;
  const km = `${sampling.acrossKm.toFixed(1)} km`;
  const spacing = DEFAULT_SAMPLE_SPACING_KM;
  return sampling.wide
    ? `${name} is ${km} across. Forecast models resolve at 2 to ${spacing} km, so a body wider than ${spacing} km can read a different forecast at each end.`
    : `${name} is ${km} across. Forecast models resolve at 2 to ${spacing} km, so points closer than ${spacing} km read the same forecast; a second point is offered only on a body wider than that.`;
}

/** The lit-item ids Water answers to. */
export const litId = {
  interior: 'sample:interior',
  point: (i: number) => `sample:${i}`,
  depth: (source: DepthSource) => `depth:${source}`,
};

/**
 * What Water asks the map to draw beyond the frame's own (which draws hand-set sample points as
 * `sample:<i>`): the interior point a body samples at by default, and the body's box as a survey's
 * two dimension lines with their lengths — what decides whether one point is enough. Water opens
 * with the Samples layer on, as its board does.
 */
export function waterMapScene(data: WaterData, lit: string | null): BodyMapScene {
  const items: MapItem[] = [];
  const { sampling, box } = data;
  if (sampling.points === null && sampling.interior !== null) {
    items.push({
      kind: 'point',
      id: litId.interior,
      layer: 'samples',
      at: [sampling.interior.lng, sampling.interior.lat],
      mark: 'sample',
      name: 'Interior point',
      hoverKicker: 'Weather samples here',
    });
  }
  if (box !== null) {
    const spans = spansKm(box);
    const midLng = (box.minLng + box.maxLng) / 2;
    const midLat = (box.minLat + box.maxLat) / 2;
    items.push(
      {
        kind: 'line',
        id: 'dimension:ew',
        layer: 'samples',
        style: 'dimension',
        path: [
          [box.minLng, box.minLat],
          [box.maxLng, box.minLat],
        ],
      },
      {
        kind: 'label',
        id: 'measure:ew',
        layer: 'samples',
        at: [midLng, box.minLat],
        text: `${spans.ew.toFixed(1)} km`,
        style: 'measure',
      },
      {
        kind: 'line',
        id: 'dimension:ns',
        layer: 'samples',
        style: 'dimension',
        path: [
          [box.minLng, box.minLat],
          [box.minLng, box.maxLat],
        ],
      },
      {
        kind: 'label',
        id: 'measure:ns',
        layer: 'samples',
        at: [box.minLng, midLat],
        text: `${spans.ns.toFixed(1)} km`,
        style: 'measure',
        angle: -90,
      },
    );
  }
  const onMap =
    lit !== null &&
    (items.some((i) => i.id === lit) ||
      (sampling.points ?? []).some((_, i) => litId.point(i) === lit));
  return { items, lit: onMap ? lit : null, layers: { samples: true } };
}
