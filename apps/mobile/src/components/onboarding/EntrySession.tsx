import { createContext, useContext } from 'react';
import {
  EMPTY_ENTRY_SESSION,
  type EntrySession,
  type EntrySessionEvent,
} from '../../lib/entryGate';

/**
 * The root navigator's session state (`src/lib/entryGate.ts`), handed to the onboarding screens:
 * they set and release the receipt hold, mark the Account step seen, and read whether to show the
 * step counter. Held in the root because the screens come and go as the gate swaps groups, and the
 * hold has to outlive the profile changing under the screen that set it.
 */
export interface EntrySessionApi {
  session: EntrySession;
  dispatch: (event: EntrySessionEvent) => void;
}

export const EntrySessionContext = createContext<EntrySessionApi>({
  session: EMPTY_ENTRY_SESSION,
  dispatch: () => {},
});

export function useEntrySession(): EntrySessionApi {
  return useContext(EntrySessionContext);
}
