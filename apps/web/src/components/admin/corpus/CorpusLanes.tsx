import type { ReactNode } from 'react';

import { Lanes } from '@/components/kit/lanes';

import { type Count, countText } from '../overview/overviewModel';

/**
 * **The one Corpus sidebar** — the task lanes and the library's, in groups (*Tasks*, *Views*,
 * *Standing*: the order is the lanes' own, as data), each with its count: the kit's `Lanes`, mounted
 * as it stands. A count no read gives is absent, never a zero; a lane with nothing in it is dim,
 * still a lane you can open. No tooltips: this is navigation.
 *
 * Routing is the caller's: `onSelect` hears the lane's id, and the route opens it fresh.
 */

export type SidebarLane = {
  id: string;
  group: string;
  label: string;
  /** The lane's count, when a read gives one. */
  count: Count | null;
};

export type CorpusLanesProps = {
  /** Every lane, in the sidebar's order; groups follow their first lane's place. */
  lanes: readonly SidebarLane[];
  /** The lane on screen. */
  selected: string;
  onSelect: (id: string) => void;
  /** The counts' failure note, at the lanes' foot (a block the one-line status bar would clip). */
  countsNote?: ReactNode;
};

/** The lanes grouped as the sidebar draws them, groups in their first lane's order. */
export function sidebarGroups(
  lanes: readonly SidebarLane[],
): { label: string; lanes: SidebarLane[] }[] {
  const groups: { label: string; lanes: SidebarLane[] }[] = [];
  for (const l of lanes) {
    const group = groups.find((g) => g.label === l.group);
    if (group) group.lanes.push(l);
    else groups.push({ label: l.group, lanes: [l] });
  }
  return groups;
}

export function CorpusLanes({ lanes, selected, onSelect, countsNote }: CorpusLanesProps) {
  return (
    <>
      <Lanes
        label="Corpus"
        selected={selected}
        onSelect={(id) => {
          // The lane on screen again keeps its place; another lane opens fresh.
          if (id !== selected) onSelect(id);
        }}
        groups={sidebarGroups(lanes).map((g) => ({
          label: g.label,
          lanes: g.lanes.map((l) => ({
            id: l.id,
            label: l.label,
            ...(l.count !== null && { count: countText(l.count) }),
            ...(l.count !== null && l.count.count === 0 && !l.count.capped && { dim: true }),
          })),
        }))}
      />
      {countsNote}
    </>
  );
}
