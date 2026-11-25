import { HIKE_IN_ASSERT_M, haversineMeters, type LatLng } from '@skating/core';

import type { LotRow, PutInRow } from './accessModel';

/**
 * **The Access tab's map tasks** (B01-6b, D313), as data: a put-in placed (its spot snapped to the
 * shore while hovering, the server snapping it again), a lot placed (where the click is), or a lot
 * linked to a put-in (a click on a lot, or *No parking*, with the hike-in assertion D144 asks for on
 * a long walk). Pure, but for the session counter that tells the map when a drawing starts over.
 */

let sessions = 0;
const nextSession = () => {
  sessions += 1;
  return sessions;
};

/** The put-in a link is for, as its card reads it. */
export type LinkTarget = Pick<PutInRow, 'id' | 'name' | 'at' | 'lotId' | 'hikeIn'>;

export type AccessDraft =
  | { kind: 'putIn'; session: number; name: string; point: LatLng | null }
  | { kind: 'lot'; session: number; name: string; point: LatLng | null }
  | {
      kind: 'link';
      session: number;
      putIn: LinkTarget;
      /** The lot picked on the map, *No parking*, or nothing yet. */
      choice: { lotId: string } | 'none' | null;
      /** Clicks that landed on no lot (the map puts its mark back on the lot picked, if any). */
      misses: number;
      /** The approach asserted a hike-in (starts as the put-in has it). */
      hikeIn: boolean;
    };

/** One kind of task's draft. */
export type DraftOf<K extends AccessDraft['kind']> = Extract<AccessDraft, { kind: K }>;

export const startPutIn = (): DraftOf<'putIn'> => ({
  kind: 'putIn',
  session: nextSession(),
  name: '',
  point: null,
});
export const startLot = (): DraftOf<'lot'> => ({
  kind: 'lot',
  session: nextSession(),
  name: '',
  point: null,
});
export const startLink = (putIn: LinkTarget): DraftOf<'link'> => ({
  kind: 'link',
  session: nextSession(),
  putIn,
  choice: null,
  misses: 0,
  hikeIn: putIn.hikeIn,
});

/**
 * How near a click must land to a lot to pick it: at least this on the ground, and at least
 * {@link LOT_PICK_RADIUS_PX} on screen — zoomed out to find a far trailhead, a marker a few pixels
 * off covers hundreds of meters. Lots that share a car park sit tens of meters apart: the nearest
 * wins.
 */
export const LOT_PICK_RADIUS_M = 150;
export const LOT_PICK_RADIUS_PX = 14;

/** The nearest lot within reach of a click (see {@link LOT_PICK_RADIUS_M}), or `null`. */
export function nearestLot(
  lots: readonly LotRow[],
  at: LatLng,
  metersPerPixel?: number,
): LotRow | null {
  const reach = Math.max(LOT_PICK_RADIUS_M, (metersPerPixel ?? 0) * LOT_PICK_RADIUS_PX);
  let best: { lot: LotRow; d: number } | null = null;
  for (const lot of lots) {
    const d = haversineMeters(at, lot.at);
    if (d <= reach && (best === null || d < best.d)) best = { lot, d };
  }
  return best?.lot ?? null;
}

/** A click on the map, as the task takes it. */
export function withPick<D extends AccessDraft>(
  draft: D,
  at: LatLng,
  lots: readonly LotRow[],
  metersPerPixel?: number,
): D {
  // Each branch keeps the draft's own kind, so a caller's narrowed draft stays narrowed.
  const d: AccessDraft = draft;
  if (d.kind !== 'link') return { ...d, point: at } as D;
  const lot = nearestLot(lots, at, metersPerPixel);
  return (lot === null ? { ...d, misses: d.misses + 1 } : { ...d, choice: { lotId: lot.id } }) as D;
}

/** The lot a link has picked, as the tab lists it. */
export function pickedLot(draft: AccessDraft, lots: readonly LotRow[]): LotRow | null {
  if (draft.kind !== 'link' || draft.choice === null || draft.choice === 'none') return null;
  const id = draft.choice.lotId;
  return lots.find((l) => l.id === id) ?? null;
}

/** A link's walk as a straight line, whole meters: what the server stores until it is routed. */
export function straightMeters(draft: AccessDraft, lots: readonly LotRow[]): number | null {
  const lot = pickedLot(draft, lots);
  return draft.kind === 'link' && lot !== null
    ? Math.round(haversineMeters(lot.at, draft.putIn.at))
    : null;
}

/** Whether the link's walk is past the line where it must be asserted a hike-in (D144). */
export function needsHikeIn(draft: AccessDraft, lots: readonly LotRow[]): boolean {
  const m = straightMeters(draft, lots);
  return m !== null && m > HIKE_IN_ASSERT_M;
}

/** What stands in the save's way, in words; `null` when it can be saved. */
export function saveBlocker(draft: AccessDraft): string | null {
  if (draft.kind === 'putIn') {
    return draft.point === null ? 'Click the shore where people get on the ice' : null;
  }
  if (draft.kind === 'lot') return draft.point === null ? 'Click where the cars park' : null;
  if (draft.choice === null) {
    return draft.misses > 0
      ? 'That click wasn’t on a lot. Click a lot, or choose No parking.'
      : 'Click a lot on the map, or choose No parking';
  }
  const same =
    draft.choice === 'none' ? draft.putIn.lotId === null : draft.choice.lotId === draft.putIn.lotId;
  if (same && draft.hikeIn === draft.putIn.hikeIn) {
    return draft.choice === 'none' ? 'It has no lot already' : 'That’s the lot it has already';
  }
  return null;
}

/** The task's header. */
export function taskHeading(draft: AccessDraft): string {
  if (draft.kind === 'putIn') return 'New put-in';
  if (draft.kind === 'lot') return 'New lot';
  return `Link a lot · ${draft.putIn.name}`;
}

/** The map's mode bar for the task: the mode, what to do next, and where the task stands. */
export function modeBarOf(draft: AccessDraft): { mode: string; line: string; step: string } {
  if (draft.kind === 'putIn') {
    return draft.point === null
      ? {
          mode: 'Put-in mode',
          line: 'Click the shore. The spot snaps to the water’s edge.',
          step: 'Step 1 of 2',
        }
      : {
          mode: 'Put-in mode',
          line: 'Drag it, or click again to move it. Then save.',
          step: 'Step 2 of 2',
        };
  }
  if (draft.kind === 'lot') {
    return draft.point === null
      ? { mode: 'Parking mode', line: 'Click where the cars park.', step: 'Step 1 of 2' }
      : {
          mode: 'Parking mode',
          line: 'Drag it, or click again to move it. Then save.',
          step: 'Step 2 of 2',
        };
  }
  return draft.choice === null
    ? {
        mode: 'Link mode',
        line: `Click the lot that serves ${draft.putIn.name}.`,
        step: 'Step 1 of 2',
      }
    : {
        mode: 'Link mode',
        line: 'Click another lot to change it. Then save.',
        step: 'Step 2 of 2',
      };
}

/** The receipt's title once the save lands. */
export function savedTitle(draft: AccessDraft, lots: readonly LotRow[]): string {
  if (draft.kind === 'putIn') {
    return draft.name.trim() ? `Put-in placed · ${draft.name.trim()}` : 'Put-in placed';
  }
  if (draft.kind === 'lot') {
    return draft.name.trim() ? `Lot placed · ${draft.name.trim()}` : 'Lot placed';
  }
  if (draft.choice === 'none') return `No parking for ${draft.putIn.name}`;
  const lot = pickedLot(draft, lots);
  return lot?.name
    ? `Linked ${lot.name} to ${draft.putIn.name}`
    : `Lot linked to ${draft.putIn.name}`;
}

/**
 * What the map draws under the tool: the spot placed, or a link's two ends as hollow rings —
 * never a line between them, which would read as a trail that isn't there.
 */
export function draftShape(draft: AccessDraft, lots: readonly LotRow[]): GeoJSON.Geometry | null {
  if (draft.kind !== 'link') return null;
  const lot = pickedLot(draft, lots);
  const ends = [draft.putIn.at, ...(lot ? [lot.at] : [])];
  return { type: 'MultiPoint', coordinates: ends.map((p) => [p.lng, p.lat]) };
}
