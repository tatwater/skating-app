import type { ComponentType } from 'react';

import type { TabMapScene } from './mapDescriptors';

/**
 * ⚠ **The frame's tab contract, restated** from `components/admin/body/frame/tabRegistry.tsx` on
 * `b01-3-body-frame` (`BodyTabProps`, `BodyTabMap`, `BodyTabRegistration`), so these tabs can export
 * their registrations before the frame lands. At integration this file is deleted and the imports
 * point at the frame's `tabRegistry`; the only difference is `describe`'s return, `TabMapScene`,
 * which becomes the frame's `BodyMapScene` once it takes the contract requests in `mapDescriptors.ts`.
 */

/** What every tab's wiring is handed. Only `bodyId` is required. */
export interface BodyTabProps {
  bodyId: string;
  /** The lit item (`?lit=`), when it belongs to this tab. */
  lit?: string | null;
  /** Light an item (or clear it with `null`); the URL keeps it. */
  onLitChange?: (lit: string | null) => void;
}

/**
 * A tab's drawing: its data, and the pure function from it to what it wants drawn. `useData` must
 * hand back the same object until the data changes, since the frame re-draws whenever its identity
 * moves.
 */
export interface BodyTabMap<D> {
  useData: (bodyId: string) => D | undefined;
  describe: (data: D, lit: string | null) => TabMapScene;
}

/** One tab's registration: its wiring and, if it draws, its map. */
export interface BodyTabRegistration<D = unknown> {
  Wiring?: ComponentType<BodyTabProps>;
  map?: BodyTabMap<D>;
}
