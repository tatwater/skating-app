import type { PeopleLane, Restriction } from '@skating/core';

import { NOT_RECORDED, STILL_PREPARING } from '../answers';

/**
 * **Every word the People list says that the boards didn't supply** — in one place, so the founder
 * can read and change them together (the Bodies list keeps its ask words the same way). The lanes'
 * sidebar names are core's (`PEOPLE_LANE_LABELS`), the trust classes' are core's, and dates and ages
 * are formatted elsewhere; everything else on the page is here.
 *
 * From the boards (8.1, 8.2): *Search any account*, *Lists*, *Suspended*, *Staff*, *admins first*,
 * *soonest to lapse first* (shortened here, below), *Until Thu 15 Oct*, *1 open flag*, *1 appeal*,
 * *Reason: “…”*, *1 appeal open*. The rest is coined, and stands until the founder rules.
 */

// ── The list head ────────────────────────────────────────────────────────────────────────────

/**
 * Each lane's display word over the list, the order its rows come in (the server's; the kicker
 * says it), and what the list says with no one in it. The orders are short enough that the kicker
 * fits the list column (`--size-list`) beside the lane's word without being cut: the board's
 * "soonest to lapse first" and the coined "most recently restricted first" did not, so they read
 * "by end date" and "latest first" (the kicker may still take a second line, `PeopleListView`).
 */
export const LANE_WORDS: Readonly<
  Record<PeopleLane, { title: string; order: string; empty: string }>
> = {
  everyone: { title: 'Everyone', order: 'by name', empty: 'No accounts yet' },
  staff: { title: 'Staff', order: 'admins first', empty: 'No staff yet' },
  suspended: { title: 'Suspended', order: 'by end date', empty: 'No one is suspended' },
  banned: { title: 'Banned', order: 'latest first', empty: 'No one is banned' },
  restricted: { title: 'Restricted', order: 'latest first', empty: 'No one is restricted' },
  flagged: {
    title: 'Flagged',
    order: 'oldest first',
    empty: 'No open flags on anyone or their content',
  },
  appeals: { title: 'Appeals open', order: 'oldest first', empty: 'No appeals waiting' },
  newest: { title: 'Newest', order: 'newest first', empty: 'No accounts made this week' },
  leaving: { title: 'Leaving', order: 'by end date', empty: 'No one is leaving' },
  deleted: { title: 'Deleted', order: 'latest first', empty: 'No deleted accounts' },
};

/** The display word and order while a search runs: it ignores the lane and ranks by match. */
export const SEARCH_WORDS = { title: 'Search', order: 'best match first' } as const;

/** What a search finds no one for. */
export const noMatch = (q: string) => `No one matches “${q}”`;

/** The list's accessible name while a search runs. */
export const searchListLabel = (q: string) => `Search: ${q}`;

// ── The lanes ────────────────────────────────────────────────────────────────────────────────

/** The sidebar's group over the lanes, and the search lane at its top. */
export const LANES_GROUP = 'Lists';
export const SEARCH_LABEL = 'Search any account';

/** The three answers that aren't a number, shared with the person page. */
export { NOT_RECORDED, STILL_PREPARING };

/** The lanes' foot while every count, or some lanes' counts, aren't ready. */
export const ALL_COUNTS_PREPARING = 'Counts still being prepared';
export const countsPreparing = (titles: readonly string[]) =>
  `${listWords(titles)} ${titles.length === 1 ? 'count' : 'counts'} still being prepared`;

/** The lanes' foot when the counts' read failed. */
export const COUNTS_FAILED = 'Counts couldn’t be read';

/** The status bar: "1 appeal open", "200+ appeals open". */
export const appealsOpen = (count: string, one: boolean) =>
  `${count} ${one ? 'appeal' : 'appeals'} open`;

// ── Notes over the rows ──────────────────────────────────────────────────────────────────────

export const MAY_NOT_HAVE_EVERYONE = 'Still being prepared: this list may not have everyone yet';
export const FLAGS_PREPARING = 'Open flags are still being prepared';

/** Why a figure is a floor — one sentence per reason the server gives. */
export const REASON_WORDS = {
  rows_missing: 'Someone the queue names isn’t listed yet, so this list is short',
  flags_capped: 'There are more open flags than one read covers, so flag figures are floors',
  tickets_capped:
    'There are more waiting tickets than one read covers, so appeal figures are floors',
  count_capped: 'The count stopped at its limit; the list goes on past it',
} as const;

// ── The list's end ───────────────────────────────────────────────────────────────────────────

export const allShown = (n: number) => `All ${n.toLocaleString('en-US')}`;
/** A list short of its lane ends on what it shows, never "All". */
export const someShown = (n: number) =>
  n === 0 ? 'None shown' : `${n.toLocaleString('en-US')} shown`;
export const LOADING_MORE = 'Loading more';
export const LIST_FAILED = 'Couldn’t read this list';
export const REST_FAILED = 'Couldn’t read the rest of this list';

/** The person column with no one open. */
export const NO_ONE_OPEN = 'No one open';

// ── A row ────────────────────────────────────────────────────────────────────────────────────

/** The status chips; written capitalized, the badge sets them in caps. */
export const CHIP_WORDS = {
  banned: 'Banned',
  suspended: 'Suspended',
  deleted: 'Deleted',
  leaving: 'Leaving',
} as const;

export const ROLE_WORDS = { admin: 'Admin', moderator: 'Moderator' } as const;

const RESTRICTION_WORDS: Record<Restriction, string> = {
  reports: 'reports',
  hazards: 'hazards',
  comments: 'comments',
  bounties: 'bounties',
  flagging: 'flagging',
};

/** The sub-line's pieces. Dates come in formatted ("Thu 15 Oct"). */
export const SUB_WORDS = {
  until: (date: string) => `Until ${date}`,
  untilLifted: 'Until lifted',
  restricted: (rights: readonly Restriction[]) =>
    `Restricted: ${listWords(rights.map((r) => RESTRICTION_WORDS[r]))}`,
  deleted: (date: string) => `Deleted ${date}`,
  deletionCompletes: (date: string) => `Deletion completes ${date}`,
  appeals: (n: number, floor: boolean) => `${n}${floor ? '+' : ''} ${plural(n, 'appeal', floor)}`,
  reason: (reason: string) => `Reason: “${reason}”`,
} as const;

/** A row's open flags: "1 open flag", and on Flagged, where they are. */
export function flagPhrase(onUser: number, onContent: number, split: boolean, floor: boolean) {
  const total = onUser + onContent;
  const head = `${total}${floor ? '+' : ''} open ${plural(total, 'flag', floor)}`;
  if (!split) return head;
  if (onUser === 0) return `${head} on their content`;
  if (onContent === 0) return `${head} on them`;
  return `${head}: ${onUser} on them, ${onContent} on their content`;
}

/** A row's time left in the deletion window, in the row's short form ("12 d left"). */
export const left = (age: string) => `${age} left`;
export const ENDS_NOW = 'Ends now';

// ── Joining words ────────────────────────────────────────────────────────────────────────────

/**
 * A word for `n` of a thing — and plural for a floor, which may be more than one ("1+ appeals"), as
 * the status bar's "1+ appeals open" and the person page's "1+ items" say it.
 */
const plural = (n: number, word: string, floor = false) => (n === 1 && !floor ? word : `${word}s`);

/** "a", "a and b", "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
