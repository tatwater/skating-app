import type { InboxItemView } from '../list/inboxTypes';
import {
  ELSEWHERE_FLAGS,
  ELSEWHERE_PHOTO,
  ELSEWHERE_SUPPORT,
  ELSEWHERE_TICKET,
} from '../words/inboxWords';
import type { HandlerKey } from './handlerRegistry';

/**
 * **Where an item without its handler is decided for now** — the placeholder's one line and its
 * link (or two) to the page that still decides that kind. Each old page retires with the PR that
 * lands the last handler it serves, so until then a kind the Inbox can't decide points at its page
 * rather than leaving the operator at a dead end.
 *
 * The old pages take no search params (neither `/admin/flags` nor `/admin/support` validates one),
 * so the links can't open
 * the item there or carry a way back: each is a plain link, same tab (the console's own pages), and
 * the browser's back returns here.
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
  'flag:photo': () => ({
    line: ELSEWHERE_PHOTO,
    links: [{ to: '/admin/flags', label: ELSEWHERE_FLAGS }],
  }),
  // Support is read only by those who answer it (D37): the link is drawn only for them.
  ticket: (_item, canReadSupport) =>
    canReadSupport
      ? { line: ELSEWHERE_TICKET, links: [{ to: '/admin/support', label: ELSEWHERE_SUPPORT }] }
      : null,
};

/** Where `item` (under `key`) is decided for now, or `null` when it has no page to point at. */
export function elsewhereFor(
  key: HandlerKey,
  item: InboxItemView,
  canReadSupport: boolean,
): Elsewhere | null {
  return ELSEWHERE[key]?.(item, canReadSupport) ?? null;
}
