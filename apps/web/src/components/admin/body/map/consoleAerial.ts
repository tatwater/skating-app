import { aerialIdentifyUrl, type LatLng, parseAerialScene } from '@skating/core';
import type * as maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { BBoxLike } from '@/lib/mapSurface';
import {
  FREEZE_UP_LAYER_PREFIX,
  type KeyedMask,
  type RevealStatus,
  useImageryReveal,
} from '../../../useImageryReveal';
import { AERIAL_LOAD_WORDS } from '../consoleWords';
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
 * - **Full color, lightly dimmed** ({@link AERIAL_PAINT}): the layer is there to place and check
 *   marks against the real ground, so the photograph has to read as one. It takes the top off the
 *   brightest pixels, a short step toward the dark map's ground.
 * - **Under the dark map's inks in either theme** (`mapInks`): a photograph is dark ground, so
 *   while it is on, the map draws its own lines and words light on dark over a dark ground; the
 *   marks and the chrome on their plates keep the page's theme.
 *
 * NAIP is a summer photograph on a two-to-three-year cycle. It is never evidence about ice, and
 * nothing here says otherwise: its credit names the program and the month it was flown.
 */

/**
 * The photograph's paint — MapLibre's raster adjustments: full color (no saturation change), its
 * brightest pixel 0.85 of full, a quarter of the way the gray paint it replaced went (founder,
 * 2026-11-25: that read as "super faded out"). One paint in both themes, since the inks over it
 * are the dark map's in both (`mapInks`, founder, 2026-11-26): lifting its shadows instead (the
 * light theme's old floor, 0.15) would gray the ground under light lines — the shore's `fg1` then
 * holds 1.5–1.8:1 against the photograph's brightest twentieth and 2.5–2.8:1 at its median, where
 * this paint holds 2.3–3.0:1 and 4.3–4.9:1.
 *
 * What it leaves the inks, measured on Mascoma and Groton (NAIP June 2023; MapLibre's raster math
 * over the cells the live map fetched, and the rendered console at 1440 × 900, the same in both
 * themes since the inks and the paint are):
 *
 * - **The shore's `fg1` against the photograph as a whole:** 2.3–3.0:1 against its brightest
 *   twentieth, 4.3–5.0:1 against its median. The gray paint held 6.8–8.0:1 at that twentieth.
 * - **Beside Mascoma's shore:** 6.2:1 at the median, 3.4:1 at the worst tenth; 9.4:1 on the water
 *   side, 4.3:1 on the land side.
 * - **The quieter `fg2`** (bays, dividers, tracks): 1.3–1.7:1 against that twentieth, 3.6:1 at the
 *   median beside the shore.
 * - **The words, against the ground in their own boxes (median, worst tenth):** the scene's labels
 *   3.4:1 and 1.6:1, the graticule's 1.8:1 and 1.5:1 — under the 4.5:1 text wants. Bare, the
 *   credit read 3.0–3.6:1 and 2.4–2.6:1 and the scale 3.1:1 and 2.1:1, so both sit on an opaque
 *   plate while the photograph is on: `fg2` on `panel`, 8.0:1 in both themes, whatever the ground.
 *
 * If that proves too little to place marks by, the fallback is the photograph at full strength and
 * the lines edged.
 */
export const AERIAL_PAINT: Readonly<Record<string, number>> = {
  'raster-brightness-max': 0.85,
  'raster-saturation': 0,
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

// ── Where the photograph stands ───────────────────────────────────────────────────────────────

/**
 * The summer aerial's state, as its credit says it:
 *
 * - **`loading`** from the switch on until **every** cell of the view is in — cells paint as they
 *   land on a first view (the reveal's `progressive`), so the photograph fills in while the credit
 *   still says it is loading. Also while the map itself is coming up (no answer yet): nothing is
 *   on screen, so it is not loaded.
 * - **`loaded`**: every cell in. The credit as it always was.
 * - **`failed`**: no cell of the view came (a network error, a refusal, a body that isn't a
 *   photograph); whatever was on screen before stays. **`partial`**: some came, some didn't.
 *   Both offer *Try again*, which asks for the missing cells only.
 *
 * A cell still waiting is loading, however long the service takes: there is no timeout, because
 * an abandoned cold render is not kept by the service's cache — giving up at 30 s on a render that
 * lands at 40 s would make every retry start from zero.
 */
export type AerialLoad = 'loading' | 'loaded' | 'failed' | 'partial';

/** The reveal's answer as the credit's state; `null` (nothing answered yet) is loading. */
export function aerialLoadOf(status: RevealStatus | null): AerialLoad {
  if (status === null || status.phase === 'loading') return 'loading';
  if (status.phase === 'loaded') return 'loaded';
  return status.failed < status.cells ? 'partial' : 'failed';
}

/** The credit's line in a state: the source, then what is still owed ("… · Loading…"). */
export function aerialCreditLine(credit: string, load: AerialLoad): string {
  return load === 'loaded' ? credit : `${credit} · ${AERIAL_LOAD_WORDS[load]}`;
}

/** What the map's dock draws beside the credit: the state, and *Try again* where it can help. */
export interface AerialLoadView {
  load: AerialLoad;
  /** Asks again for what didn't come; offered only while `failed` or `partial`. */
  onRetry?: () => void;
  /** *Try again* was pressed and its answer isn't in yet. */
  pending?: boolean;
}

/** The summer aerial on a live console map, while `on`; its state for the credit (`null` off). */
export function useConsoleAerial({
  liveMap,
  on,
  bbox,
}: {
  liveMap: () => maplibregl.Map | null;
  on: boolean;
  bbox: BBoxLike;
}): AerialLoadView | null {
  const { minLng, minLat, maxLng, maxLat } = bbox;
  const masks = useMemo(
    () => (on ? aerialMasks({ minLng, minLat, maxLng, maxLat }) : null),
    [on, minLng, minLat, maxLng, maxLat],
  );
  const [status, setStatus] = useState<RevealStatus | null>(null);
  const [pending, setPending] = useState(false);
  const onStatusChange = useCallback((next: RevealStatus | null) => {
    setStatus(next);
    // Try again is answered once the view settles again (or the layer comes down).
    if (next === null || next.phase !== 'loading') setPending(false);
  }, []);
  // The live map or nothing, re-read every render: a theme switch's new map gets the layer anew,
  // and the old one's teardown never writes to a removed map.
  const live = liveMap();
  const { retry } = useImageryReveal({
    map: live,
    loaded: live !== null,
    masks,
    unmasked: true,
    minZoom: 0,
    anchor: anchorOn,
    paint: AERIAL_PAINT,
    progressive: true,
    onStatusChange,
  });
  const onRetry = useCallback(() => {
    setPending(true);
    retry();
  }, [retry]);
  if (!on) return null;
  return aerialLoadView(aerialLoadOf(status), onRetry, pending);
}

/**
 * The state with *Try again* where it can help — and, once pressed, held as *Trying again…* while
 * the credit says it is loading again, so the button the operator pressed doesn't vanish under
 * them; it goes when the answer is in.
 */
export function aerialLoadView(
  load: AerialLoad,
  onRetry: () => void,
  pending: boolean,
): AerialLoadView {
  if (load === 'failed' || load === 'partial') return { load, onRetry, pending };
  if (load === 'loading' && pending) return { load, onRetry, pending };
  return { load };
}

/**
 * A still's state (a story's, a test's): the one it was handed, and *Try again* that holds as
 * *Trying again…* — there is no service behind a still to answer it.
 */
export function useStillAerialLoad(load: AerialLoad = 'loaded'): AerialLoadView {
  const [pending, setPending] = useState(false);
  return aerialLoadView(load, () => setPending(true), pending);
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

/** The service's own error body: ArcGIS answers a failed ask with a 200 and `{ error: … }`. */
const refused = (json: unknown): boolean =>
  typeof json === 'object' && json !== null && 'error' in json;

/**
 * When the service says the photograph at `point` was taken; `null` for no answer. Never throws.
 * Only an answer is remembered — a date, or a photograph with no date there. A refusal (a status
 * that isn't ok, the service's error body) is a failed ask like a dropped connection: remembering
 * it as "nothing dated there" would leave every later map of the place without its month until
 * the page was loaded again.
 */
export function aerialDate(point: LatLng, fetcher: typeof fetch = fetch): Promise<number | null> {
  const url = aerialIdentifyUrl(point);
  const known = dates.get(url);
  if (known !== undefined) return known;
  const asked = fetcher(url, { mode: 'cors' })
    .then((r) => {
      if (!r.ok) throw new Error('The identify ask was refused');
      return r.json();
    })
    .then((json) => {
      if (refused(json)) throw new Error('The identify ask was refused');
      return parseAerialScene(json)?.capturedAt ?? null;
    })
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
