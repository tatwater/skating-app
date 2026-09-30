/**
 * Landmarks in the report sheet (D202 × D193) — what the *where* picker offers, and what a tap on
 * the lake becomes. Shared by both surfaces so the phone and the console rank the same names first
 * and name the same tap the same way.
 *
 * Its own module because it needs both `where.ts` (the point it builds) and `landmarks.ts` (what it
 * builds from), and `where.ts` already reads `landmarks.ts`.
 */

import { haversineMeters, type LatLng } from './geometry';
import { type LandmarkKind, landmarkNameKey } from './landmarks';
import type { WherePoint } from './where';

/** What the sheet knows of a landmark — `landmarks.listForBody`'s view, trimmed to what it reads. */
export interface SheetLandmark {
  _id: string;
  name: string;
  kind: LandmarkKind;
  point: LatLng;
  aliases: readonly string[];
  subAreaId?: string;
  prominence: number;
}

/**
 * How near a known landmark a tap must land to be named for it — the founder's call: a point marked
 * close to a known landmark takes its name. Wide enough for a thumb on a phone's silhouette of a
 * big lake, narrow enough that a tap mid-bay stays a tap.
 */
export const LANDMARK_SNAP_M = 150;

/** How many landmarks the picker shows as chips before the search takes over. */
export const SHEET_LANDMARK_CHIPS = 8;

/**
 * The landmarks the picker offers as chips, and how many more the search holds. Scoped to the bay
 * when one is chosen (the landmarks *in* Malletts Bay, not the lake's), ranked by prominence, then —
 * when a caller passes `near` — by nearness to it, then by name. Neither picker passes `near` yet:
 * the put-in lives in another section of the sheet, and threading it through every where question is
 * a change for when prominence alone proves the wrong order.
 */
export function landmarksForSheet(
  landmarks: readonly SheetLandmark[],
  options: { subAreaId?: string; near?: LatLng; limit?: number } = {},
): { chips: SheetLandmark[]; more: number } {
  const scoped =
    options.subAreaId === undefined
      ? landmarks
      : landmarks.filter((l) => l.subAreaId === options.subAreaId);
  const near = options.near;
  const ranked = [...scoped].sort(
    (a, b) =>
      b.prominence - a.prominence ||
      (near ? haversineMeters(a.point, near) - haversineMeters(b.point, near) : 0) ||
      a.name.localeCompare(b.name),
  );
  const limit = options.limit ?? SHEET_LANDMARK_CHIPS;
  return { chips: ranked.slice(0, limit), more: Math.max(0, ranked.length - limit) };
}

/** The landmarks a typed query finds — by any name or spelling, most prominent first. */
export function searchLandmarks(
  landmarks: readonly SheetLandmark[],
  query: string,
  limit = SHEET_LANDMARK_CHIPS,
): SheetLandmark[] {
  const key = landmarkNameKey(query);
  if (!key) return [];
  return landmarks
    .filter((l) => [l.name, ...l.aliases].some((n) => landmarkNameKey(n).includes(key)))
    .sort((a, b) => b.prominence - a.prominence || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The nearest landmark within `maxMeters` of a coordinate, or `null`. */
export function nearestLandmark(
  coord: LatLng,
  landmarks: readonly SheetLandmark[],
  maxMeters = LANDMARK_SNAP_M,
): SheetLandmark | null {
  let best: { landmark: SheetLandmark; distance: number } | null = null;
  for (const landmark of landmarks) {
    const distance = haversineMeters(coord, landmark.point);
    if (distance > maxMeters) continue;
    if (!best || distance < best.distance) best = { landmark, distance };
  }
  return best?.landmark ?? null;
}

/** A `where` point standing for a landmark: its point, its name, its id. */
export function landmarkPoint(landmark: SheetLandmark, radiusMeters: number): WherePoint {
  return { coord: landmark.point, radiusMeters, name: landmark.name, landmarkId: landmark._id };
}

/**
 * What a tap on the lake becomes: the tapped coordinate, named for the nearest landmark within
 * {@link LANDMARK_SNAP_M} when there is one (the tap stays where it landed — the skater meant *there*,
 * near the landmark, not the landmark's label point).
 */
export function pointFromTap(
  coord: LatLng,
  landmarks: readonly SheetLandmark[],
  radiusMeters: number,
): WherePoint {
  const near = nearestLandmark(coord, landmarks);
  return near
    ? { coord, radiusMeters, name: near.name, landmarkId: near._id }
    : { coord, radiusMeters };
}

/**
 * Words that name a *kind* of place: a landmark called "The Point" or "The Gut" is real on its own
 * lake, and "through the gut" means it — but the word inside another name ("off Shelburne Point")
 * is some other place.
 */
const GENERIC_PLACE_WORDS = new Set([
  'point',
  'island',
  'islands',
  'bay',
  'cove',
  'rock',
  'rocks',
  'beach',
  'narrows',
  'gut',
  'bridge',
  'dam',
  'marina',
  'harbor',
  'reef',
  'shoal',
  'ledge',
  'inlet',
  'outlet',
  'landing',
  'camp',
]);

/**
 * Which landmark a phrase names — "off Shelburne Point", "by the gut", "west of bird poop rock" —
 * or `null`. A landmark's name or any spelling must appear in the phrase as whole words (folded as
 * `landmarkNameKey` folds), and the longest match wins, so "Shelburne Point" beats "Shelburne".
 * Two rules keep it from guessing: a spelling that is one generic word ("The Point" → "point")
 * matches only as "the point" or the whole phrase, and two *different* landmarks tied on the
 * longest match — Champlain's two Long Points — name neither. The extraction uses it to turn a `placeName` into an id, and a wrong
 * id is worse than none.
 */
export function landmarkNamedIn<T extends { name: string; aliases: readonly string[] }>(
  phrase: string,
  landmarks: readonly T[],
): T | null {
  const text = ` ${landmarkNameKey(phrase)} `;
  let best: { landmark: T; length: number; tied: boolean } | null = null;
  for (const landmark of landmarks) {
    for (const name of [landmark.name, ...landmark.aliases]) {
      const key = landmarkNameKey(name);
      if (!key || !text.includes(` ${key} `)) continue;
      // A one-word kind of place names this landmark only as "the gut", "the point" — or as the
      // whole phrase. "off Shelburne Point" is some other point.
      if (GENERIC_PLACE_WORDS.has(key) && !text.includes(` the ${key} `) && text.trim() !== key) {
        continue;
      }
      if (!best || key.length > best.length) best = { landmark, length: key.length, tied: false };
      else if (key.length === best.length && best.landmark !== landmark) best.tied = true;
    }
  }
  return best && !best.tied ? best.landmark : null;
}
