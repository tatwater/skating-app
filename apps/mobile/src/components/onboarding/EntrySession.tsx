import { api } from '@skating/convex/api';
import type { EntryStanding } from '@skating/core';
import { useQuery } from 'convex/react';
import { createContext, useContext, useRef } from 'react';
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

/**
 * The profile as this screen sees it right now, by ref: a refusal heard after an `await` records the
 * standing the profile has then (`{ type: 'cannotAct', profile }`), not the one a render closed over.
 */
export function useProfileNow(): { readonly current: EntryStanding | null | undefined } {
  const profile = useQuery(api.profiles.current, {});
  const now = useRef<EntryStanding | null | undefined>(profile);
  now.current = profile;
  return now;
}
