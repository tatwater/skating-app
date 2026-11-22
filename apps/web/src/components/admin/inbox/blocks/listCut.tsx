import { countOf } from '../words/inboxWords';

/**
 * **A member list the read may have served short** — one way for every Inbox list (an item's asks,
 * flags and access reports) to say how many of how many it shows, so none passes a page off as
 * everyone and none says it differently.
 *
 * The item's own count (`memberCount`) counts its **open** members while any is open, else all of
 * them (`deriveItem` on the server); a list holds the newest or oldest of each status. So what a list
 * shows is counted the same way ({@link countedLike}) before it is set against the item's count.
 * `cut` is the server's own word that it stopped the list short of that count (`asksCut`,
 * `flagsCut`, `reportsCut`: the item's budget couldn't hold the next member whole).
 */

/** An item's count of its members, whether it is a floor, and whether the list was cut short. */
export type ListTotal = { count: number; floor: boolean; cut: boolean };

/** The item's total, as `inbox.item` serves it, with the list's own cut flag. */
export const listTotalOf = (
  item: { memberCount: number; memberCountIsFloor: boolean },
  cut: boolean,
): ListTotal => ({ count: item.memberCount, floor: item.memberCountIsFloor, cut });

/** The members counted as the item's count counts them: the open ones while any is, else all. */
export function countedLike(members: readonly { status: 'open' | 'closed' }[]): number {
  const open = members.filter((m) => m.status === 'open').length;
  return open > 0 ? open : members.length;
}

/** Whether the list shows every member the item counts. */
export const isWhole = (shown: number, total: ListTotal): boolean =>
  !total.cut && !total.floor && total.count <= shown;

/** The nouns a list counts. */
export type ListNoun = 'asks' | 'flags' | 'reports';

const SINGULAR: Record<ListNoun, string> = { asks: 'ask', flags: 'flag', reports: 'report' };

/** "Showing 50 of 500+ asks", or `null` when the list shows every member the item counts. */
export function shownLine(shown: number, total: ListTotal, noun: ListNoun): string | null {
  if (isWhole(shown, total)) return null;
  const word = total.count === 1 && !total.floor ? SINGULAR[noun] : noun;
  return `Showing ${countOf(shown)} of ${countOf(total.count, total.floor)} ${word}`;
}

/**
 * A count a section's rule ends in: what it shows while the list is whole, else the item's own count
 * ("500+" past its floor) — never a page's length passed off as the total.
 */
export function listCount(
  shown: number,
  total: ListTotal,
): number | { count: number; capped: boolean } {
  return isWhole(shown, total) ? shown : { count: total.count, capped: total.floor };
}

/** The line under a list the read served short; nothing when it is whole. */
export function ListCutLine({
  members,
  total,
  noun,
}: {
  members: readonly { status: 'open' | 'closed' }[];
  total: ListTotal;
  noun: ListNoun;
}) {
  const line = shownLine(countedLike(members), total, noun);
  if (line === null) return null;
  return (
    <span data-slot="list-cut" className="text-assist leading-body text-fg3">
      {line}
    </span>
  );
}
