/**
 * What a click on the instrument means in each sub-mode (B03 §5, boards 5.13–5.15) — the rule the
 * console's `ConsoleMode` callbacks are fed by, pure over a projection so it is a unit test.
 *
 * - **where** (5.13/5.14): outside the ring, the click names the sector by its bearing from the
 *   lake's origin (the same rule the ring's arcs and the wedges are cut by); inside it, a point on
 *   the water — named for the landmark it lands near (`whereClickOnWater`).
 * - **put-in** (5.15): a launch or lot within reach of the click wins (snap), else the shore takes
 *   it as *somewhere else*.
 * - **place**: a photo's spot is the click.
 *
 * The map is the pointer's shortcut; every launch, bay and sector here is also a chip beside it.
 */

import {
  type CompassRing,
  compassRing,
  type LatLng,
  onRing,
  type Projection,
  ringSectorAtXY,
  type SheetLandmark,
} from '@skating/core';
import type { ConsoleMode } from './ConsoleMode';
import type { InstrumentPin } from './instrumentFeatures';
import { whereClickOnWater } from './WhereCards';
import { patchWhere } from './WherePicker';

/** How near a launch a click has to land to choose it, px — the old silhouette's reach. */
export const PIN_SNAP_PX = 14;

/** The ring around the lake's origin for this frame, or `null` when it can't fit. */
export function instrumentRing(projection: Projection, origin: LatLng | null): CompassRing | null {
  if (origin === null) return null;
  return compassRing(projection, origin, { labelOffset: 16 });
}

/** The nearest pin within `PIN_SNAP_PX` of a screen point, or `null`. */
export function snapPin(
  pins: readonly InstrumentPin[],
  projection: Pick<Projection, 'toXY'>,
  xy: [number, number],
): InstrumentPin | null {
  let best: { pin: InstrumentPin; d: number } | null = null;
  for (const pin of pins) {
    const [x, y] = projection.toXY([pin.coord.lng, pin.coord.lat]);
    const d = Math.hypot(x - xy[0], y - xy[1]);
    if (d <= PIN_SNAP_PX && (best === null || d < best.d)) best = { pin, d };
  }
  return best?.pin ?? null;
}

export interface PickContext {
  /** The map as it is drawn now; absent before it loads (a click then is the plain coordinate). */
  projection?: Projection;
  origin: LatLng | null;
  pins: readonly InstrumentPin[];
  landmarks: readonly SheetLandmark[];
}

/** Feed one click to the open mode. A click with no mode open is nobody's. */
export function pickOnInstrument(mode: ConsoleMode | null, coord: LatLng, ctx: PickContext): void {
  if (mode === null) return;
  const xy = ctx.projection?.toXY([coord.lng, coord.lat]);
  if (mode.kind === 'where') {
    const ring = ctx.projection ? instrumentRing(ctx.projection, ctx.origin) : null;
    if (ring && xy) {
      const d = Math.hypot(xy[0] - ring.cx, xy[1] - ring.cy);
      if (d > ring.r || onRing(ring, xy)) {
        const sector = ringSectorAtXY(ring, xy);
        mode.onChange(
          patchWhere(mode.where, { sector: mode.where?.sector === sector ? undefined : sector }),
        );
        return;
      }
    }
    mode.onChange(whereClickOnWater(mode.where, coord, ctx.landmarks));
    return;
  }
  if (mode.kind === 'putIn') {
    const pin = ctx.projection && xy ? snapPin(ctx.pins, ctx.projection, xy) : null;
    if (pin) mode.onPickPin(pin.id, pin.kind);
    else mode.onPickShore(coord);
    return;
  }
  mode.onPlace(coord);
}
