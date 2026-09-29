/**
 * The library grid's hand-off (A10-8 §8.5, iOS): what the Photos section tells the full-screen
 * grid when it opens it, and which library photo became which draft photo, so the reel and the grid
 * agree on what is already included, and a second tap on either removes rather than re-adds.
 *
 * A module-level note, as `hazardPrefill` is: the grid is its own route, and a draft photo is a
 * pair of file URIs, not a route param. Dies with the process; a draft reopened later shows its
 * photos on the Report and simply not checked in the library.
 */

import type { ActivityWindow, GridOtherReport, PassedTrackPoint } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { useSyncExternalStore } from 'react';

export interface LibraryGridRequest {
  reportId: string;
  timeZone: string;
  /** The skate itself, unpadded — the ice rail; `null` before an end time. */
  skate: ActivityWindow | null;
  /** The window the reel asks for (the skate, padded) — `null` before an end time. */
  skateWindow: ActivityWindow | null;
  /** The whole local day — of the end time, or of today before there is one. */
  dayWindow: ActivityWindow;
  others: GridOtherReport[];
  outline?: Polygon | MultiPolygon | null;
  track: PassedTrackPoint[];
}

let request: LibraryGridRequest | null = null;

export function openLibraryGridRequest(next: LibraryGridRequest): void {
  request = next;
}

export function getLibraryGridRequest(): LibraryGridRequest | null {
  return request;
}

// ── Which asset became which draft photo, per Report ──────────────────────────────────────────

let picks: Readonly<Record<string, Readonly<Record<string, string>>>> = {};
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** The Report's library picks: asset id → draft photo id. */
export function getPicks(reportId: string): Readonly<Record<string, string>> {
  return picks[reportId] ?? EMPTY;
}
const EMPTY: Readonly<Record<string, string>> = {};

export function setPicks(reportId: string, next: Readonly<Record<string, string>>): void {
  picks = { ...picks, [reportId]: next };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePicks(reportId: string): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    subscribe,
    () => getPicks(reportId),
    () => getPicks(reportId),
  );
}
