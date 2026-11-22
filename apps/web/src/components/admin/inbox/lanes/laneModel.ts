import { INBOX_LANES, type InboxLane, type InboxListLane } from '@skating/core';
import type { FacetMenuCount } from '@/components/kit/facet-menu';
import { countText } from '../../overview/overviewModel';
import type { InboxLanesView } from '../list/inboxTypes';
import { LANE_LABELS, LANES_GROUP, RECORD_GROUP } from '../words/inboxWords';

/**
 * **The Inbox's sidebar, as a model** — which lanes a viewer has, in the boards' order, and what
 * each row shows from `inbox.lanes` (boards 2.1–2.9, the left column):
 *
 * - **Lanes**: All open, then each lane in the flow-through order (safety first), Support only for a
 *   viewer with support's read (D37 — the server leaves its figures out for anyone else).
 * - **Record**: Decided (every decision, newest first), then *Today* — decided since the console's
 *   local midnight — a quiet figure that opens the Decided list.
 * - **Counts** are the server's tallies (`inboxCounts`), never counted here. A lane with nothing in
 *   it dims; Safety's count is red while anything waits in it (the boards'). While the server
 *   prepares the stored items (`pending`) or the read failed, no row shows a number: a figure that
 *   may be wrong is never drawn (the foot says why).
 */

/** A sidebar row's id: a list lane, or `today` (which opens Decided). */
export type SidebarLane = InboxListLane | 'today';

export type SidebarRow = {
  id: SidebarLane;
  label: string;
  count?: string;
  countTone?: 'default' | 'bad';
  dim?: boolean;
};

export type SidebarGroup = { label: string; lanes: SidebarRow[] };

/** The lanes a viewer has, in the sidebar's order (All open first). */
export function lanesFor(canReadSupport: boolean): InboxListLane[] {
  return ['all', ...INBOX_LANES.filter((l) => canReadSupport || l !== 'support')];
}

/** Whether a lanes read may be drawn as numbers: answered, and not still being prepared. */
export function countsShown(view: InboxLanesView | undefined | null): view is InboxLanesView {
  return view != null && !view.pending;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * The sidebar's two groups. `view` is the lanes read's answer (`undefined` while on its way or
 * failed); counts show only from a finished one.
 */
export function sidebarGroups(
  view: InboxLanesView | undefined,
  canReadSupport: boolean,
): SidebarGroup[] {
  const shown = countsShown(view) ? view : null;
  const byLane = new Map<InboxLane, number>(shown?.lanes.map((l) => [l.lane, l.open]) ?? []);
  const row = (id: SidebarLane, open: number | undefined, tone?: 'bad'): SidebarRow => ({
    id,
    label: LANE_LABELS[id],
    ...(open !== undefined && { count: fmt(open) }),
    ...(open !== undefined && open > 0 && tone !== undefined && { countTone: tone }),
    ...(open === 0 && { dim: true }),
  });
  const lanes = lanesFor(canReadSupport).map((id) =>
    id === 'all'
      ? row('all', shown?.allOpen)
      : row(
          id,
          shown === null ? undefined : (byLane.get(id as InboxLane) ?? 0),
          id === 'safety' ? 'bad' : undefined,
        ),
  );
  const decided: SidebarRow = {
    id: 'decided',
    label: LANE_LABELS.decided,
    ...(shown !== null && { count: fmt(shown.decided) }),
  };
  // Today is a figure more than a list: always the quiet ink, its count a floor once capped.
  const today: SidebarRow = {
    id: 'today',
    label: LANE_LABELS.today,
    dim: true,
    ...(shown !== null && { count: countText(shown.today) }),
  };
  return [
    { label: LANES_GROUP, lanes },
    { label: RECORD_GROUP, lanes: [decided, today] },
  ];
}

/** The list a sidebar row opens: Today opens Decided (its newest are today's). */
export function laneOfRow(id: SidebarLane): InboxListLane {
  return id === 'today' ? 'decided' : id;
}

/**
 * The rail's Inbox count — "a count where a count means work": every open item the viewer may
 * read, amber (it waits on a person), and nothing at all when nothing waits, while it is being
 * prepared, or while the read is out (never a `0`, never a guess).
 */
export function inboxRailCount(view: InboxLanesView | undefined | null): {
  count?: string;
  countTone?: 'warn';
} {
  if (!countsShown(view) || typeof view.allOpen !== 'number' || view.allOpen <= 0) return {};
  return { count: fmt(view.allOpen), countTone: 'warn' };
}

/** The status bar's groups' facts: Safety's open count, and today's decided. */
export function statusFacts(
  view: InboxLanesView | undefined,
): { safety: number; today: string } | null {
  if (!countsShown(view)) return null;
  const safety = view.lanes.find((l) => l.lane === 'safety')?.open ?? 0;
  return { safety, today: countText(view.today) };
}

/** The console's local midnight on the day `at` falls on — the day *Today* counts from. */
export function localMidnight(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The filter menu's age counts for a list: each floor's open count, from the lanes' `olderThan` —
 * a lane's own, or All open's as the sum of its lanes'. A count the server stopped at its cap is a
 * floor, drawn "200+" (the kit's facet menu takes a `Count`); for All open, a floor any lane capped
 * makes the sum a floor too. Access counts only its first 200 items by rank, so past that its counts
 * come back capped and read as floors. Decided has none.
 */
export function ageCountsFor(
  view: InboxLanesView | undefined,
  lane: InboxListLane,
): Record<number, FacetMenuCount> | undefined {
  if (!countsShown(view) || lane === 'decided') return undefined;
  const lanes = lane === 'all' ? view.lanes : view.lanes.filter((l) => l.lane === lane);
  if (lanes.length === 0) return undefined;
  const sums: Record<number, number> = {};
  const capped = new Set<number>();
  for (const l of lanes) {
    for (const { days, count } of l.olderThan) {
      if (count.capped) capped.add(days);
      sums[days] = (sums[days] ?? 0) + count.count;
    }
  }
  // A floor where any lane's count stopped at its cap ("200+"); an exact number otherwise.
  const out: Record<number, FacetMenuCount> = {};
  for (const [d, n] of Object.entries(sums)) {
    out[Number(d)] = capped.has(Number(d)) ? { count: n, capped: true } : n;
  }
  return out;
}
