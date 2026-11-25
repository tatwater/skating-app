import type { Doc } from '@skating/convex/dataModel';
import type { InboxDecision, InboxLane, RequestKind } from '@skating/core';

import { plural } from '@/lib/ages';

import { FLAG_WORDS, REQUEST_WORDS } from '../../bodies/askWords';

/**
 * **Every word the Inbox's frame draws** — the lanes, the list, the inspector's frame and its lock,
 * the zero page — in one place, so the founder can read and change them together. The handlers keep
 * their own words beside them; the request kinds and the flag reasons are the Bodies preview's
 * founder-approved ones (`bodies/askWords.ts`), read from there so a kind is never worded twice.
 *
 * **From the boards** (2.1–2.9, `inbox-v5.html`, `inbox-handler-v5.html`, `states-v5.html`):
 * the lane names, *Lanes*, *Record*, *Decided*, *Today*, *N open*, *All N*, *Decided this week*,
 * *Decided today*, *Nothing open*, *Filter*, *All*, each lane's tab names, *Inbox zero*, *Open, today*,
 * *Decided today, by lane*, *Not in the inbox*, *Corpus →*, *Machinery →*, *Decided by ‹name› · 14:42 ·
 * approved*, *History →*, *Back to the queue*, the row chips the boards draw (*unsafe*, *report*,
 * *disputes 12 Sep*, *2 reports*, *catalog match · 41 ac*, *no candidate*, *lookalike 0.4 mi*, *drawn
 * body*, *92 % overlap*, *access alert*, *photo*, *appeal*, and the decided chips) and the sub-lines'
 * shapes (*Mascoma Lake · by Rob Tremblay · flagged by Sarah Berman*, *Asked by 2 · "…"*).
 *
 * **Coined here** (none of these is on a board; each stands until the founder's copy pass) — the
 * report lists them: {@link COINED}.
 */

// ── The lanes ────────────────────────────────────────────────────────────────────────────────

/** The sidebar's names, as the boards write them (the Overview's `INBOX_LANE_LABEL` agrees). */
export const LANE_LABELS: Readonly<Record<InboxLane | 'all' | 'decided' | 'today', string>> = {
  all: 'All open',
  safety: 'Safety',
  accessReports: 'Access reports',
  requests: 'Requests',
  placesAsked: 'Places asked',
  drawnBodies: 'Drawn bodies',
  contentFlags: 'Content flags',
  support: 'Support',
  decided: 'Decided',
  today: 'Today',
};

/** The two groups in the sidebar. */
export const LANES_GROUP = 'Lanes';
export const RECORD_GROUP = 'Record';

/** The Inbox's navigation name (the lanes' `nav`). */
export const LANES_NAV = 'Inbox';

/** Under the lanes while the server prepares the stored items (coined). */
export const LANES_PENDING = 'Still being prepared';

/** The counts' read failed (coined, as People's). */
export const COUNTS_FAILED = 'The counts didn’t load.';

// ── The list head ────────────────────────────────────────────────────────────────────────────

/** "1 open", "19 open" — the head's kicker. */
export const openCount = (count: string) => `${count} open`;

/** The Decided lane's kicker (coined): its order. */
export const DECIDED_KICKER = 'newest first';

/** Each lane's tabs, `all` first — the boards' words where they drew them. */
export const FACET_LABELS: Readonly<Record<string, string>> = {
  all: 'All',
  reports: 'Reports',
  hazards: 'Hazards',
  people: 'People',
  disputes: 'Disputes',
  new: 'New',
  admit: 'Admit',
  activate: 'Activate',
  restore: 'Restore',
  contest_access: 'Contest access',
  takedown: 'Takedown',
  bays: 'Bays',
  landmarks: 'Landmarks',
  overlap: 'Overlap',
  newWater: 'New water',
  comments: 'Comments',
  alerts: 'Alerts',
  photos: 'Photos',
  account: 'Account',
  bug: 'Bug',
  safety: 'Safety',
  other: 'Other',
};

/** A facet's tab word; an unknown one reads as itself, capitalized. */
export function facetLabel(facet: string): string {
  return FACET_LABELS[facet] ?? facet.charAt(0).toUpperCase() + facet.slice(1);
}

// ── The filter menu ──────────────────────────────────────────────────────────────────────────

export const FILTER = 'Filter';
export const FILTER_AGE = 'Waiting at least';
export const FILTER_BODY = 'Body';
export const FILTER_PERSON = 'Person';
export const FILTER_CLEAR = 'Clear';
/** An age floor's option ("1 d", "30 d"), as a row's age is written. */
export const ageFloorLabel = (days: number) => `${days} d`;
/** A filter chip for a body or a person whose name the page doesn't hold (coined). */
export const FILTER_BODY_UNNAMED = 'One body';
export const FILTER_PERSON_UNNAMED = 'One person';
export const FIND_BODY = 'Find a body';
export const FIND_PERSON = 'Find a person';
/** A filter search's read failed (coined) — never shown as "no results". */
export const SEARCH_FAILED = 'The search didn’t load.';

// ── The list ─────────────────────────────────────────────────────────────────────────────────

/** "All 3" — the list-end tab. */
export const allOf = (count: number) => `All ${count.toLocaleString('en-US')}`;
export const NOTHING_OPEN = 'Nothing open';
export const DECIDED_THIS_WEEK = 'Decided this week';
export const DECIDED_TODAY = 'Decided today';

/** List states (coined, as People's). */
export const LIST_FAILED = 'The list didn’t load.';
export const REST_FAILED = 'The rest of the list didn’t load.';
export const LOADING_MORE = 'Loading more';
export const NOT_RECORDED = 'Not recorded yet';
export const STILL_PREPARING = 'Still being prepared';
/** The list may be missing items while the server prepares them (coined). */
export const LIST_PENDING = 'Still being prepared — some items may not be listed yet.';
/** The filter's scan ended the page, not the list (coined). */
export const MORE_TO_READ = 'More to read';
export const READ_ON = 'Read on';
/** The tail's read failed (coined). */
export const TAIL_FAILED = 'This week’s decisions didn’t load.';
/** Nothing decided this week in a lane: the tail draws nothing at all (no filler). */

/** A filtered list with nothing in it (coined). */
export const NOTHING_MATCHES = 'Nothing open matches';
export const NOTHING_DECIDED = 'Nothing decided yet';

/**
 * A count as the Inbox writes it: "1,204", or "500+" when the server's count stopped at its bound
 * (`memberCountIsFloor`) — a floor is never passed off as a total.
 */
export const countOf = (n: number, floor = false) =>
  `${n.toLocaleString('en-US')}${floor ? '+' : ''}`;

// ── Row chips ────────────────────────────────────────────────────────────────────────────────

/** A flag's reason as a row's chip — the boards' short words. */
export const REASON_CHIP: Readonly<Record<Doc<'contentFlags'>['reason'], string>> = {
  unsafe_false_report: 'unsafe',
  spam: 'spam',
  harassment: 'harassment',
  inappropriate: 'inappropriate',
  auto_low_quality: 'rated unhelpful',
  no_public_access: 'no public access',
  other: 'other',
};

/** What a flag is on, as a row's chip. */
export const TARGET_CHIP: Readonly<Record<Doc<'contentFlags'>['targetType'], string>> = {
  report: 'report',
  post: 'post',
  comment: 'comment',
  hazard: 'hazard',
  photo: 'photo',
  accessAlert: 'access alert',
  waterbody: 'body',
  user: 'person',
};

/** A request's kind as a row's chip (the boards drew the raw kind; the approved words are kinder). */
export const requestChip = (kind: RequestKind): string => REQUEST_WORDS[kind].toLowerCase();

/** "2 reports", "1 report". */
export const reportsChip = (n: number, floor = false) =>
  floor ? `${countOf(n, true)} reports` : plural(n, 'report', 'reports');
/** "disputes 12 Sep". */
export const disputesChip = (when: string) => `disputes ${when}`;
/** "catalog match · 41 ac". */
export const catalogChip = (acres: string) => `catalog match · ${acres}`;
export const NO_CANDIDATE = 'no candidate';
/** "lookalike 0.4 mi". */
export const lookalikeChip = (distance: string) => `lookalike ${distance}`;
export const DRAWN_CHIP = 'drawn body';
/** "92 % overlap". */
export const overlapChip = (percent: number) => `${percent} % overlap`;
export const AUTO_CHIP = 'filed by the app';
export const GONE_CHIP = 'deleted';
/** A flag's content its author withdrew (deleted, or since erased) — the handlers' "Withdrawn on …". */
export const WITHDRAWN_CHIP = 'withdrawn';
/** A withdrawn item's sub-line leads with it (coined). */
export const WITHDRAWN_SUB = 'Withdrawn by its author';
export const DOWN_CHIP: Readonly<Record<'hidden' | 'removed', string>> = {
  hidden: 'hidden',
  removed: 'removed',
};

/** A ticket's category as a row's chip. */
export const TICKET_CHIP: Readonly<Record<Doc<'supportTickets'>['category'], string>> = {
  account: 'account',
  bug: 'bug',
  safety: 'safety',
  other: 'other',
};

/**
 * A decision as a moderator says it — a decided row's chip and the lock's line ("Decided by Sarah
 * Berman · 14:42 · hidden"). The boards' words where they drew them (dismissed, hidden, removed,
 * pinned, unpinned, no public access, confirmed accessible, approved, merged, rejected, resolved); the rest
 * coined (listed in {@link COINED}). `cleared` is in the vocabulary but nothing writes it today.
 */
export const DECISION_WORDS: Readonly<Record<InboxDecision, string>> = {
  dismissed: 'dismissed',
  // A flag actioned without a takedown of its own here — every flag decided before the Inbox reads
  // it, whatever was done — so it claims only that a moderator acted, never what.
  actioned: 'action taken',
  hidden: 'hidden',
  removed: 'removed',
  pinned: 'pinned',
  unpinned: 'unpinned',
  retracted: 'retracted',
  restored: 'restored',
  ruled_closed: 'no public access',
  ruled_accessible: 'confirmed accessible',
  approved: 'approved',
  declined: 'declined',
  merged: 'merged',
  rejected: 'rejected',
  resolved: 'resolved',
};

// ── Row sub-lines ────────────────────────────────────────────────────────────────────────────

export const byAuthor = (name: string) => `by ${name}`;
export const flaggedBy = (name: string) => `flagged by ${name}`;
export const FILED_BY_APP = 'Filed by the app';
/** "4th occurrence", "21st occurrence". */
export function occurrence(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n.toLocaleString('en-US')}${suffix} occurrence`;
}
/** "Asked by 2". */
export const askedBy = (n: number, floor = false) => `Asked by ${countOf(n, floor)}`;
/** "From a report's where". */
export const FROM_REPORT = 'From a report’s where';
export const FROM_SKATE = 'From a recorded skate';
/** "Luc Pelletier and 2 more". */
export const andMore = (name: string, more: number, floor = false) =>
  more > 0 ? `${name} and ${countOf(more, floor)} more` : name;
/** A decided row's sub-line: who decided it ("Sarah"), then what it says. */
export const SOMEONE = 'A staff member';
/** A row whose label facts are gone (coined). */
export const UNTITLED = 'Untitled';
/** "A photo", "A comment" — a flag's target with no words of its own (coined). */
export const TARGET_TITLE: Readonly<Record<Doc<'contentFlags'>['targetType'], string>> = {
  report: 'A report',
  post: 'A post',
  comment: 'A comment',
  hazard: 'A hazard',
  photo: 'A photo',
  accessAlert: 'An access alert',
  waterbody: 'A body',
  user: 'A person',
};

// ── The inspector ────────────────────────────────────────────────────────────────────────────

/** Nothing open in the inspector (coined, as People's *No one open*). */
export const NOTHING_SELECTED = 'Nothing open';
export const NO_SUCH_ITEM = 'No such item';
/** A ref to nothing (coined, People's shape). */
export const NO_SUCH_ITEM_BODY =
  'Nothing in the inbox matches this link. It may have been withdrawn by the person who filed it.';
/** A ref while the server prepares the items: not yet, never "no such" (coined). */
export const ITEM_PENDING = 'Still being prepared';
export const ITEM_PENDING_BODY =
  'The inbox is still being prepared. This item will open once it is ready.';
export const ITEM_FAILED = 'This item didn’t load.';
/** The Support read's own refusal, word for word (`inbox.ts`'s `SUPPORT_REFUSAL`). */
export const SUPPORT_REFUSED = 'Support tickets are read only by staff who answer them';
export const BACK_TO_LIST = 'Back to the list';
// *Back to the queue* and the lock's *Decided by …* moved with the frame to
// `admin/inspector/inspectorWords.ts` (B01-7a).
/** *History →* (the link chip draws the arrow). */
export const HISTORY = 'History';

/** A decider whose profile is gone (coined). */
export const DECIDER_GONE = 'a former staff member';

/** The inspector's own name for readers. */
export const INSPECTOR_LABEL = 'Item';
export const LIST_LABEL = 'List';
export const LANES_LABEL = 'Lanes';

/** The placeholder handler's head words, by kind (coined) — the item's facts, read only. */
export const KIND_HEAD: Readonly<Record<string, string>> = {
  flag: 'Flag',
  access: 'Access reports',
  request: 'Request',
  place: 'Place asked',
  drawn: 'Drawn body',
  ticket: 'Support ticket',
};
/**
 * The placeholder's line: a kind the Inbox can't decide yet, and the page that still decides it
 * (coined). The link words wear the link chip's arrow.
 */
export const FACT_LANE = 'Lane';
export const FACT_FILED = 'Filed';
export const FACT_MEMBERS = 'Filed by';
export const FACT_BODY = 'Body';
export const FACT_SUBJECT = 'About';
export const FACT_REASONS = 'Reasons';
export const FACT_NOTE = 'Note';
export const people = (n: number, floor = false) =>
  floor ? `${countOf(n, true)} people` : plural(n, 'person', 'people');

// ── Inbox zero (2.9) ─────────────────────────────────────────────────────────────────────────

export const INBOX_ZERO = 'Inbox zero';
/** "As of 15:02, 22 decided today, a median of 1.5 days from filing to decision." */
export function zeroLine(asOf: string, decided: string, median: string | null): string {
  const head = `As of ${asOf}, ${decided} decided today`;
  return median === null ? `${head}.` : `${head}, a median of ${median} from filing to decision.`;
}
/** Nothing decided today yet (coined). */
export const zeroQuiet = (asOf: string) => `As of ${asOf}, nothing decided today.`;
export const OPEN_TODAY = 'Open, today';
/** The server can't tell how many were open as the day began (coined). */
export const OPEN_START_UNKNOWN =
  'How many were open as the day began isn’t known: more was filed or decided today than this page reads.';
export const LEGEND_OPEN = 'Open';
export const LEGEND_FILED = 'Filed';
export const LEGEND_DECIDED = 'Decided';
export const DECIDED_BY_LANE = 'Decided today, by lane';
export const NOT_IN_INBOX = 'Not in the inbox';
/** The zero page's short lane names (the board's). */
export const ZERO_LANE_WORDS: Readonly<Record<InboxLane, string>> = {
  safety: 'Safety',
  accessReports: 'Access',
  requests: 'Requests',
  placesAsked: 'Places',
  drawnBodies: 'Drawn',
  contentFlags: 'Flags',
  support: 'Support',
};
export const CORPUS_LINK = 'Corpus';
export const MACHINERY_LINK = 'Machinery';
export const CORPUS = 'Corpus';
export const MACHINERY = 'Machinery';
/** "ZERO 15:02" — the chart's mark where the line reached nothing. */
export const zeroAt = (time: string) => `Zero ${time}`;
/** The day's read was cut at its cap (coined). */
export const TODAY_CAPPED = 'More than the chart can hold today; it shows the first 500.';

/** A median, written out: "1.5 days", "5 hours", "12 minutes". */
export function medianWords(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 24) {
    const days = Math.round((hours / 24) * 10) / 10;
    return `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`;
  }
  if (hours >= 1) return plural(Math.floor(hours), 'hour', 'hours');
  return plural(Math.max(0, Math.floor(ms / 60_000)), 'minute', 'minutes');
}

/** The flag reasons in words, re-exported for the frame's readers. */
export { FLAG_WORDS };

/**
 * Every word above that no board supplied — the list the report carries for the copy pass.
 */
export const COINED = [
  'Still being prepared',
  'The counts didn’t load.',
  'newest first',
  'Waiting at least',
  'One body',
  'One person',
  'Find a body',
  'Find a person',
  'The list didn’t load.',
  'The rest of the list didn’t load.',
  'Loading more',
  'Not recorded yet',
  'Still being prepared — some items may not be listed yet.',
  'More to read',
  'Read on',
  'This week’s decisions didn’t load.',
  'Nothing open matches',
  'Nothing decided yet',
  'filed by the app',
  'ruling cleared',
  'action taken',
  'withdrawn',
  'Withdrawn by its author',
  'retracted',
  'restored',
  'declined',
  'A staff member',
  'Untitled',
  'No such item',
  'Nothing in the inbox matches this link. It may have been withdrawn by the person who filed it.',
  'The inbox is still being prepared. This item will open once it is ready.',
  'This item didn’t load.',
  'Back to the list',
  'a former staff member',
  'As of ‹time›, nothing decided today.',
  'More than the chart can hold today; it shows the first 500.',
] as const;
