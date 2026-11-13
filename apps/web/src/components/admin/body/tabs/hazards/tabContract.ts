/*
 * ── THE FRAME'S CONTRACT, COPIED ─────────────────────────────────────────────────────────────────
 * The types the four tabs' registrations need from `components/admin/body/frame/tabRegistry.tsx`
 * on branch `b01-3-body-frame` (84ec6bc5), copied verbatim. At integration this file is deleted and
 * every import of it points at `../../frame/tabRegistry`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { ComponentType } from 'react';

import type { BodyMapScene } from './mapDescriptors';

/** What every tab's wiring is handed. Only `bodyId` is required; the rest arrive when the frame has them. */
export interface BodyTabProps {
  bodyId: string;
  /** The lit item (`?lit=`), when it belongs to this tab. */
  lit?: string | null;
  /** Light an item (or clear it with `null`); the URL keeps it. */
  onLitChange?: (lit: string | null) => void;
}

/**
 * A tab's drawing: its data, and the pure function from it to what it wants drawn. `useData` must
 * hand back the same object until the data changes (a Convex result already does; a constant for a
 * tab with nothing to read), since the frame re-draws whenever its identity moves.
 */
export interface BodyTabMap<D> {
  useData: (bodyId: string) => D | undefined;
  describe: (data: D, lit: string | null) => BodyMapScene;
}

/** One tab's registration: its wiring and, if it draws, its map. */
export interface BodyTabRegistration {
  Wiring?: ComponentType<BodyTabProps>;
  // biome-ignore lint/suspicious/noExplicitAny: each tab has its own data; the frame only threads it from `useData` to `describe`.
  map?: BodyTabMap<any>;
}
