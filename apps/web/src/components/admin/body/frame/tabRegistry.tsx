import type { ComponentType } from 'react';

import type { BodyMapScene } from '../map/mapDescriptors';
import { BODY_TABS, type BodyTabKey } from './bodySearch';

/**
 * **The tab contract** — the one thing the nine tabs and the frame agree on.
 *
 * Each tab lives in `components/admin/body/tabs/<key>/` and exports two things the frame plugs into
 * its slot here:
 *
 * - **`Wiring`** — a small component that takes {@link BodyTabProps} (at least `{ bodyId }`), reads
 *   its own data, and renders the tab's props-only view. It draws only inside the inspector, under
 *   the tab grid; it never touches the map.
 * - **`map`** (optional) — the tab's drawing, as data: `useData(bodyId)` reads what the drawing
 *   needs (the same Convex reads its wiring makes; the client dedupes them to one subscription) and
 *   `describe(data, lit)` is a **pure function** from that data to a {@link BodyMapScene}. The frame
 *   draws the scene over its own (the outline, the bays, the marks, the access points).
 *
 * A slot with no `Wiring` draws the tab's *Not built yet* state, so the grid always holds nine and
 * the URL can name any of them. Tabs are registered at integration, by adding them to
 * {@link registerBodyTabs}'s argument in the route wiring — never by a tab importing the frame.
 */

/** What every tab's wiring is handed. Only `bodyId` is required; the rest arrive when the frame has them. */
export interface BodyTabProps {
  bodyId: string;
  /** The lit item (`?lit=`), when it belongs to this tab. */
  lit?: string | null;
  /** Light an item (or clear it with `null`); the URL keeps it. */
  onLitChange?: (lit: string | null) => void;
}

/** A tab's drawing: its data, and the pure function from it to what it wants drawn. */
export interface BodyTabMap<D> {
  useData: (bodyId: string) => D | undefined;
  describe: (data: D, lit: string | null) => BodyMapScene;
}

export interface BodyTabSlot {
  key: BodyTabKey;
  /** The tab's word in the grid, written capitalized ("Shape"); the grid sets it in caps. */
  label: string;
  /** The tab's wiring. Absent: the slot draws *Not built yet*. */
  Wiring?: ComponentType<BodyTabProps>;
  /** The tab's drawing. Absent: the frame draws its own scene alone. */
  // biome-ignore lint/suspicious/noExplicitAny: each tab has its own data; the frame only threads it from `useData` to `describe`.
  map?: BodyTabMap<any>;
}

export const BODY_TAB_LABELS: Record<BodyTabKey, string> = {
  shape: 'Shape',
  names: 'Names',
  places: 'Places',
  access: 'Access',
  water: 'Water',
  imagery: 'Imagery',
  hazards: 'Hazards',
  standing: 'Standing',
  links: 'Links',
};

/** One tab's registration: its wiring and, if it draws, its map. */
export type BodyTabRegistration = Pick<BodyTabSlot, 'Wiring' | 'map'>;

export type BodyTabRegistry = Readonly<Record<BodyTabKey, BodyTabSlot>>;

/**
 * The nine slots, in the grid's order, with whatever tabs are built so far filled in. A key not
 * given stays a *Not built yet* slot.
 */
export function registerBodyTabs(
  built: Partial<Record<BodyTabKey, BodyTabRegistration>>,
): BodyTabRegistry {
  return Object.fromEntries(
    BODY_TABS.map((key) => [key, { key, label: BODY_TAB_LABELS[key], ...built[key] }]),
  ) as Record<BodyTabKey, BodyTabSlot>;
}

/** Whether a slot has a tab in it yet. */
export function isBuilt(slot: BodyTabSlot): boolean {
  return slot.Wiring !== undefined;
}
