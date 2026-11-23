import type { InboxItemView } from '../list/inboxTypes';
import type { HandlerKey } from './handlerRegistry';

/**
 * **Where an item without its handler is decided for now** — the placeholder's one line and its
 * link (or two) to the page that still decides that kind. Each old page retires with the PR that
 * lands the last handler it serves, so until then a kind the Inbox can't decide points at its page
 * rather than leaving the operator at a dead end.
 *
 * The old pages that took a kind's items have all retired (`/admin/flags` with B01-5e,
 * `/admin/support` with B01-5f), so the map is empty. A link here is a plain one, same tab (the
 * console's own pages), and the browser's back returns here.
 */

export type ElsewhereLink = { to: string; label: string };
export type Elsewhere = { line: string; links: ElsewhereLink[] };

/** Every handler key, at runtime — the type check below holds it to `HandlerKey`. */
export const HANDLER_KEYS = [
  'flag:report',
  'flag:post',
  'flag:comment',
  'flag:hazard',
  'flag:photo',
  'flag:accessAlert',
  'flag:waterbody',
  'flag:user',
  'access',
  'request',
  'place',
  'drawn',
  'ticket',
] as const satisfies readonly HandlerKey[];

// A `HandlerKey` this list misses is a type error here, so a new kind can't slip past the test.
type Missing = Exclude<HandlerKey, (typeof HANDLER_KEYS)[number]>;
const everyKey: [Missing] extends [never] ? true : Missing = true;
void everyKey;

/** The kinds whose page is known while their handler hasn't landed; a key absent here has one. */
export const ELSEWHERE: Partial<
  Record<HandlerKey, (item: InboxItemView, canReadSupport: boolean) => Elsewhere | null>
> = {
  // Empty: every kind has its handler. A kind a newer server sends that this build has no handler
  // for draws the placeholder's facts alone.
};

/** Where `item` (under `key`) is decided for now, or `null` when it has no page to point at. */
export function elsewhereFor(
  key: HandlerKey,
  item: InboxItemView,
  canReadSupport: boolean,
): Elsewhere | null {
  return ELSEWHERE[key]?.(item, canReadSupport) ?? null;
}
