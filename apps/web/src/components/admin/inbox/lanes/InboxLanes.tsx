import type { InboxListLane } from '@skating/core';
import type { KeyboardEvent, ReactNode } from 'react';

import { Lanes } from '@/components/kit/lanes';

import type { InboxLanesView } from '../list/inboxTypes';
import { LANES_NAV, LANES_PENDING } from '../words/inboxWords';
import { laneOfRow, type SidebarLane, sidebarGroups } from './laneModel';

/**
 * **The Inbox's lanes** (boards 2.1–2.9, the left column): the kit `Lanes` — *Lanes* (All open, then
 * each lane safety first), then *Record* (Decided, Today). It picks **which list** the middle column
 * shows; a lane's tabs sit over that list, never here.
 *
 * The counts are `inbox.lanes`' (`sidebarGroups`): none while the read is out, failed or being
 * prepared — then the foot says *Still being prepared* — and the count's note (a failed read's) sits
 * under the lanes. Keys are the kit's: one tab stop, ↑↓ between lanes, typing jumps, ⏎ picks.
 */
export function InboxLanes({
  view,
  canReadSupport,
  selected,
  onSelect,
  countsNote,
  onKeyDown,
}: {
  /** The lanes read's answer (held through a change of list), or `undefined`. */
  view: InboxLanesView | undefined;
  canReadSupport: boolean;
  /** The list on screen. */
  selected: InboxListLane;
  onSelect: (lane: InboxListLane) => void;
  /** The counts' failure note, under the lanes. */
  countsNote?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const groups = sidebarGroups(view, canReadSupport);
  return (
    <>
      <Lanes
        label={LANES_NAV}
        data-slot="inbox-lanes"
        className="min-h-0 flex-1"
        selected={selected}
        groups={groups}
        onSelect={(id) => onSelect(laneOfRow(id as SidebarLane))}
        {...(onKeyDown !== undefined && { onKeyDown })}
        {...(view?.pending === true && {
          foot: <span data-slot="inbox-lanes-pending">{LANES_PENDING}</span>,
        })}
      />
      {countsNote}
    </>
  );
}
