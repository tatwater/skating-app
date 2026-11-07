import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createContext, type ReactNode, useContext, useState } from 'react';

/**
 * A memory router around a story (story-only; nothing in the app imports it). The panels' views
 * render router `Link`s — the lake, an author, a sibling report — and a `Link` needs a router above
 * it. The story's own tree rides in a context, so re-renders reach it without rebuilding the router.
 */
const Slot = createContext<ReactNode>(null);

function SlotOutlet() {
  return <>{useContext(Slot)}</>;
}

export function StoryRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: SlotOutlet }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    }),
  );
  return (
    <Slot.Provider value={children}>
      <RouterProvider router={router} />
    </Slot.Provider>
  );
}
