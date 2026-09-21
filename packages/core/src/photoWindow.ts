/**
 * *Photos from your skate* (A10 §3.5 / §8.1): which of the phone's photos fall in the activity
 * window, and where each one sits along the path — pure, given the track.
 *
 * The media-library query is the platform's; this decides the window it asks for and places what
 * comes back. Placement prefers the photo's own EXIF coordinate (the D31/D42 pass already reads it
 * on device; `takenAt` is read here for the first time) and otherwise **interpolates along the
 * track at the moment the photo was taken** — a phone with location services off for the camera
 * still knows when the shutter fired, and the track knows where the skater was then. The result is
 * a local preview *before* anything uploads; the skater picks the subset, the rest are simply not
 * uploaded, and nothing is ever deleted from the camera roll. `placeOnMap` stays the D42 opt-in
 * and is the visible consequence of the preview.
 */

import { haversineMeters, type LatLng } from './geometry';
import type { PassedTrackPoint } from './passedHazards';
import { zonedInstant, zonedParts } from './zonedTime';

/** The default pad either side of the activity — a photo of the launch, a photo of the car. */
export const PHOTO_WINDOW_PAD_MS = 30 * 60_000;

export interface ActivityWindow {
  startMs: number;
  endMs: number;
}

/** A photo as the library describes it before upload: its time, and its EXIF coordinate if any. */
export interface LibraryPhoto {
  id: string;
  takenAtMs?: number;
  coord?: LatLng;
}

/** The activity window padded on both sides — what the library is asked for. */
export function photoWindow(activity: ActivityWindow, padMs = PHOTO_WINDOW_PAD_MS): ActivityWindow {
  return { startMs: activity.startMs - padMs, endMs: activity.endMs + padMs };
}

/** The wider option: the whole local day of the activity's end, in the body's zone. */
export function sameDayWindow(activity: ActivityWindow, timeZone: string): ActivityWindow {
  const p = zonedParts(activity.endMs, timeZone);
  return {
    startMs: zonedInstant(p.year, p.month, p.day, 0, timeZone),
    endMs: zonedInstant(p.year, p.month, p.day, 24 * 60, timeZone),
  };
}

/** The photos whose taken time falls in the window, oldest first. Undated photos never match. */
export function photosInWindow<T extends LibraryPhoto>(
  photos: readonly T[],
  window: ActivityWindow,
): T[] {
  return photos
    .filter(
      (p) =>
        p.takenAtMs !== undefined && p.takenAtMs >= window.startMs && p.takenAtMs <= window.endMs,
    )
    .sort((a, b) => (a.takenAtMs as number) - (b.takenAtMs as number));
}

export type PhotoPlacementSource = 'exif' | 'path';

export interface PhotoPlacement {
  coord: LatLng;
  source: PhotoPlacementSource;
  /** For a path placement: how far the interpolated point is from the nearest fix, as an honesty hint. */
  gapMeters?: number;
}

/**
 * Where a photo was taken: its EXIF coordinate, else the track position at its taken time —
 * linearly interpolated between the two fixes bracketing it, clamped to the track's ends when the
 * shutter fired before the first fix or after the last. `null` when neither is knowable (no
 * coordinate and no time, or no time and an empty track).
 */
export function placePhoto(
  photo: LibraryPhoto,
  track: readonly PassedTrackPoint[],
): PhotoPlacement | null {
  if (photo.coord) return { coord: photo.coord, source: 'exif' };
  if (photo.takenAtMs === undefined || track.length === 0) return null;
  const t = photo.takenAtMs;
  const first = track[0] as PassedTrackPoint;
  const last = track[track.length - 1] as PassedTrackPoint;
  if (t <= first.timestamp)
    return { coord: { lat: first.lat, lng: first.lng }, source: 'path', gapMeters: 0 };
  if (t >= last.timestamp)
    return { coord: { lat: last.lat, lng: last.lng }, source: 'path', gapMeters: 0 };
  for (let i = 0; i + 1 < track.length; i++) {
    const a = track[i] as PassedTrackPoint;
    const b = track[i + 1] as PassedTrackPoint;
    if (t < a.timestamp || t > b.timestamp) continue;
    const span = b.timestamp - a.timestamp;
    const f = span === 0 ? 0 : (t - a.timestamp) / span;
    const coord = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    return {
      coord,
      source: 'path',
      gapMeters: Math.min(haversineMeters(coord, a), haversineMeters(coord, b)),
    };
  }
  return null;
}
