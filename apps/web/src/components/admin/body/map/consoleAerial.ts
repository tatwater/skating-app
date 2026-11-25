import { aerialIdentifyUrl, type LatLng, parseAerialScene } from '@skating/core';
import type * as maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useState } from 'react';

import type { BBoxLike } from '@/lib/mapSurface';
import {
  FREEZE_UP_LAYER_PREFIX,
  type KeyedMask,
  useImageryReveal,
} from '../../../useImageryReveal';
import type { BodyMapMode } from './bodyMapPalette';
import { rasterAnchor } from './glLayers';

/**
 * **The console map's summer aerial** — USGS NAIP (0.3 m, flown leaf-on), **unmasked**: the whole
 * view, not clipped to the lake, so an operator reads the ground round the shore (where a put-in
 * sits, whether a mark is on the water) and the shore itself. One layer for every console map: the
 * Body console's (a rack switch on every tab) and the embeds that draw it (the Corpus head map).
 *
 * Built on the skater app's reveal (`useImageryReveal`, its unmasked mode — the old lake editor's),
 * so it inherits what that hook learned the hard way: **every request is a grid cell** (the URL is a
 * pure function of the ground, so the service's CDN and the browser's store answer a repeat in
 * 0.08 s, where an unsnapped bbox is a ~29 s cold render), at most four cells a view, a stale view's
 * fetch abandoned, the layer written only to the live map. What the console adds:
 *
 * - **Its own band.** The photograph goes where the console's layer contract (`MAP_BANDS`) puts a
 *   raster: over the body's fill, under the hazard fields and every line, so the shore and the
 *   marks draw on it. Under any winter pass already up (Imagery's), never over it.
 * - **No zoom floor.** The console's camera is fenced to one body, so its widest view still wants
 *   the photograph; the grid steps down a level rather than asking for more cells.
 * - **Dimmed toward the ground** ({@link AERIAL_PAINT}): the console's inks are grays, so the dark
 *   mode darkens the photograph and the light mode lifts it, each a step toward gray, and the shore,
 *   the bays and the marks keep their contrast over it.
 *
 * NAIP is a summer photograph on a two-to-three-year cycle. It can never show ice, and nothing here
 * says it does: its credit names the program and the month it was flown.
 */

/**
 * The photograph's paint by mode — MapLibre's raster adjustments, toward the console's ground: in
 * the dark, its brightest pixel under half (so `fg1`'s shore stays the brightest line); in the
 * light, its darkest lifted past half (so the dark inks read). Both a step toward gray. Measured on
 * the painted pixels of Mascoma and Groton (NAIP June 2023): the shore's `fg1` holds at least 5:1
 * against the brightest (dark) or darkest (light) twentieth of the photograph.
 */
export const AERIAL_PAINT: Readonly<Record<BodyMapMode, Readonly<Record<string, number>>>> = {
  dark: { 'raster-brightness-max': 0.42, 'raster-saturation': -0.4 },
  light: { 'raster-brightness-min': 0.58, 'raster-saturation': -0.4 },
};

/**
 * Where the photograph's layer goes: under the lowest winter pass in the style (a pass is the
 * newer, more specific picture), else at the console's raster band. Read from the layers' ids
 * alone (`getLayersOrder`), never `getStyle()`.
 */
export function consoleAerialAnchor(layerIds: readonly string[]): string | undefined {
  return layerIds.find((id) => id.startsWith(FREEZE_UP_LAYER_PREFIX)) ?? rasterAnchor(layerIds);
}

const anchorOn = (map: maplibregl.Map) => consoleAerialAnchor(map.getLayersOrder());

/**
 * The one "body" the reveal is handed: the frame's box. Unmasked, the reveal clips nothing, so this
 * only says *on* — and keys the view, so another body redraws.
 */
export function aerialMasks(bbox: BBoxLike): KeyedMask[] {
  const { minLng, minLat, maxLng, maxLat } = bbox;
  const key = `aerial:${minLng},${minLat},${maxLng},${maxLat}`;
  return [
    {
      id: key,
      key,
      mask: {
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [minLng, minLat],
              [maxLng, minLat],
              [maxLng, maxLat],
              [minLng, maxLat],
              [minLng, minLat],
            ],
          ],
        },
      },
    },
  ];
}

/** The summer aerial on a live console map, while `on`. */
export function useConsoleAerial({
  liveMap,
  on,
  bbox,
  mode,
}: {
  liveMap: () => maplibregl.Map | null;
  on: boolean;
  bbox: BBoxLike;
  mode: BodyMapMode;
}): void {
  const { minLng, minLat, maxLng, maxLat } = bbox;
  const masks = useMemo(
    () => (on ? aerialMasks({ minLng, minLat, maxLng, maxLat }) : null),
    [on, minLng, minLat, maxLng, maxLat],
  );
  // The live map or nothing, re-read every render: a theme switch's new map gets the layer anew,
  // with the new mode's paint, and the old one's teardown never writes to a removed map.
  const live = liveMap();
  useImageryReveal({
    map: live,
    loaded: live !== null,
    masks,
    unmasked: true,
    minZoom: 0,
    anchor: anchorOn,
    paint: AERIAL_PAINT[mode],
  });
}

// ── The credit ────────────────────────────────────────────────────────────────────────────────

/** The credit's words: the program, and the month it was flown when the service says (UTC). */
export function aerialCredit(capturedAt: number | null): string {
  if (capturedAt === null || !Number.isFinite(capturedAt)) return 'Aerial · NAIP';
  const d = new Date(capturedAt);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `Aerial · NAIP ${month} ${d.getUTCFullYear()}`;
}

/**
 * The identify point for a frame: its middle, snapped to a thousandth of a degree (~100 m), so two
 * maps of one body ask one URL and the answer is shared. One point is enough: a body inside one
 * NAIP quarter-quad was flown on one day, and one that spans two was flown the same season.
 */
export function creditPoint(bbox: BBoxLike): LatLng {
  const snap = (v: number) => Math.round(v * 1000) / 1000;
  return { lat: snap((bbox.minLat + bbox.maxLat) / 2), lng: snap((bbox.minLng + bbox.maxLng) / 2) };
}

/** Answers by URL for the session: settled dates (or `null`: nothing dated there) and in-flight asks. */
const dates = new Map<string, Promise<number | null>>();

/** When the service says the photograph at `point` was taken; `null` for no answer. Never throws. */
export function aerialDate(point: LatLng, fetcher: typeof fetch = fetch): Promise<number | null> {
  const url = aerialIdentifyUrl(point);
  const known = dates.get(url);
  if (known !== undefined) return known;
  const asked = fetcher(url, { mode: 'cors' })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => parseAerialScene(json)?.capturedAt ?? null)
    .catch(() => {
      // A failed ask isn't remembered: the next map may try again.
      dates.delete(url);
      return null;
    });
  dates.set(url, asked);
  return asked;
}

/** Test support: forget every answer. */
export function forgetAerialDates(): void {
  dates.clear();
}

/**
 * The credit for a live map while the aerial is on: "Aerial · NAIP" at once, and the month it was
 * flown once the service has said (asked once per place a session, only while on).
 */
export function useAerialCredit(on: boolean, bbox: BBoxLike): string | null {
  const point = creditPoint(bbox);
  const { lat, lng } = point;
  const [answer, setAnswer] = useState<{ key: string; at: number | null } | null>(null);
  const key = `${lat},${lng}`;
  useEffect(() => {
    if (!on) return;
    let live = true;
    void aerialDate({ lat, lng }).then((at) => {
      if (live) setAnswer({ key: `${lat},${lng}`, at });
    });
    return () => {
      live = false;
    };
  }, [on, lat, lng]);
  if (!on) return null;
  return aerialCredit(answer?.key === key ? answer.at : null);
}
