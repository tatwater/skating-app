/**
 * The library grid (A10-8 §8.5, iOS): the phone's photos for the skate or the day, under a header
 * per **local hour**. Hours the skate covers carry an ice rail; hours another Report of the Post
 * covers carry that Report's number, as its tab and the timeline number it. Pure, so the hour a
 * photo falls under is decided once, across a DST day and in a half-hour zone alike.
 *
 * An hour is an **instant**, not a wall-clock label: the night the clocks fall back has two
 * "1 AM"s an hour apart, and each keeps its own photos; both headers then say which is which
 * (the zone's short name). Nothing here is a safety claim (D3): times are when the photo was taken.
 */

import type { ActivityWindow } from './photoWindow';
import { floorToLocalHour } from './sheetTimeline';

const HOUR_MS = 3_600_000;

export interface GridPhotoInput {
  id: string;
  takenAtMs: number;
}

/** Another Report of the Post, numbered as its tab is (time order, from 1). */
export interface GridOtherReport {
  number: number;
  startMs?: number;
  endMs: number;
}

export interface GridHour<P extends GridPhotoInput> {
  /** The local hour's first instant. */
  hourStartMs: number;
  /** "4 PM"; "1 AM EDT" / "1 AM EST" when the day has that hour twice. */
  label: string;
  photos: P[];
  /** Does the skate itself cover any of this hour? The ice rail. */
  inSkate: boolean;
  /** The other Reports that cover any of this hour, by number. */
  reports: number[];
}

export interface GridInput {
  timeZone: string;
  /** This Report's skate, unpadded — `null` before it has an end time. */
  skate: ActivityWindow | null;
  others?: readonly GridOtherReport[];
}

/** Does [from, to] (an instant when equal) touch the hour starting at `hour`? */
function touches(hour: number, from: number, to: number): boolean {
  return from < hour + HOUR_MS && to >= hour;
}

function hourLabels(hours: readonly number[], timeZone: string): string[] {
  const plain = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric' });
  const zoned = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    timeZoneName: 'short',
  });
  const labels = hours.map((h) => plain.format(h));
  const seen = new Map<string, number>();
  for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
  return labels.map((l, i) => ((seen.get(l) ?? 0) > 1 ? zoned.format(hours[i] as number) : l));
}

/** The photos grouped under their local hours, oldest first, with each hour's marks. */
export function libraryGrid<P extends GridPhotoInput>(
  photos: readonly P[],
  input: GridInput,
): GridHour<P>[] {
  const sorted = [...photos].sort((a, b) => a.takenAtMs - b.takenAtMs);
  const groups: { hourStartMs: number; photos: P[] }[] = [];
  for (const photo of sorted) {
    const hour = floorToLocalHour(photo.takenAtMs, input.timeZone);
    const last = groups[groups.length - 1];
    if (last && last.hourStartMs === hour) last.photos.push(photo);
    else groups.push({ hourStartMs: hour, photos: [photo] });
  }
  const labels = hourLabels(
    groups.map((g) => g.hourStartMs),
    input.timeZone,
  );
  const others = input.others ?? [];
  return groups.map((g, i) => ({
    hourStartMs: g.hourStartMs,
    label: labels[i] as string,
    photos: g.photos,
    inSkate: input.skate !== null && touches(g.hourStartMs, input.skate.startMs, input.skate.endMs),
    reports: others
      .filter((o) => touches(g.hourStartMs, o.startMs ?? o.endMs, o.endMs))
      .map((o) => o.number)
      .sort((a, b) => a - b),
  }));
}

/** *Select all from the skate*: the ids of the photos inside the window the reel asks for. */
export function photoIdsInWindow(
  photos: readonly GridPhotoInput[],
  window: ActivityWindow,
): string[] {
  return photos
    .filter((p) => p.takenAtMs >= window.startMs && p.takenAtMs <= window.endMs)
    .map((p) => p.id);
}
