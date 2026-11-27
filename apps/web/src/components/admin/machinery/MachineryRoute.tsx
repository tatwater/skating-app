import { api } from '@skating/convex/api';
import { Link, Outlet } from '@tanstack/react-router';
import { createContext, type ReactNode, useContext } from 'react';

import { useRole } from '@/lib/useRole';

import { useTickingNow } from '../body/tabs/tabParts';
import { isFailed, loaded, read, useConsoleReadSet } from '../reads/consoleReads';
import { ReadNote } from '../reads/ReadNote';
import { useHeldRead, useMinuteNow } from '../shell/presence';
import { laneTailAt } from './liveness';
import { type MachineryLaneId, MachineryLanes } from './MachineryLanes';
import type { MachineryLanesView } from './machineryTypes';
import { LANES_FAILED } from './words/machineryWords';

/**
 * **Machinery's frame, wired** (the `/admin/machinery` layout): the sidebar's one read
 * (`machineryRuns.lanes`, on the minute, held through the minute's turn and never past a failure),
 * kept here so every page under it shares it, and the outlet. Each page lays out its own columns
 * on the console's one narrow rule (`useColumnsFit`), mounting the sidebar this layout hands it
 * (`useMachinerySidebar`) as its first column — Corpus's way, so the three columns are one grid
 * that the rule measures whole.
 *
 * Every read waits on `machinery.read`: the rail never draws the mode for anyone without it, and a
 * page reached by its URL reads nothing.
 */

type SidebarFor = (selected: MachineryLaneId) => ReactNode;

const SidebarContext = createContext<SidebarFor>(() => null);

/** The sidebar, as the page under this layout mounts it, with its lane on screen. */
export function useMachinerySidebar(selected: MachineryLaneId): ReactNode {
  return useContext(SidebarContext)(selected);
}

/** The sidebar's lane links: each built page, opened fresh. */
const laneLink = (id: MachineryLaneId) => <Link to={`/admin/machinery/${id}`} />;

export function MachinerySidebarProvider({ children }: { children: ReactNode }) {
  const { can } = useRole();
  const canRead = can('machinery.read');
  const now = useMinuteNow();
  const { reads } = useConsoleReadSet({
    lanes: canRead ? read(api.machineryRuns.lanes, { now }) : null,
  });
  const state = reads.lanes;
  const shown = useHeldRead<MachineryLanesView>(loaded(state), !canRead || isFailed(state));
  // The tail re-read on the list's clock, from the inputs a live tail carries (`laneTailAt`).
  const tick = useTickingNow(TAIL_TICK_MS);
  const sidebar: SidebarFor = (selected) => (
    <>
      <MachineryLanes
        tails={shown === undefined ? {} : { corpus: laneTailAt(shown.corpus, tick) }}
        selected={selected}
        now={now}
        link={laneLink}
      />
      <ReadNote
        data-slot="lanes-error"
        className="shrink-0 border-0 border-t border-solid border-line px-(--space-4_5) py-(--space-3) empty:border-0 empty:p-0"
        reads={[state]}
      >
        {LANES_FAILED}
      </ReadNote>
    </>
  );
  return <SidebarContext.Provider value={sidebar}>{children}</SidebarContext.Provider>;
}

/** How often a live tail is re-read: each second, as the list's rows are. */
const TAIL_TICK_MS = 1_000;

export function MachineryRoute() {
  return (
    <MachinerySidebarProvider>
      <Outlet />
    </MachinerySidebarProvider>
  );
}
