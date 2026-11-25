import { type RefObject, useRef, useState } from 'react';
import type { DecidedState } from '../../../inspector/InspectorFrame';
import { InspectorProvider, useInspectorContext } from '../../../inspector/inspectorContext';
import type { HandlerKey, InboxHandler } from '../../inspector/handlerRegistry';
import type { InboxRowView } from '../../list/inboxTypes';
import { TicketView } from './TicketView';
import { useTicketDraft } from './ticketDrafts';
import { TICKET_NOW, TICKET_TZ } from './ticketFixtures';
import type { TicketItem } from './ticketModel';
import type { TicketAct } from './useTicketWrites';

/**
 * **Story support for the ticket handler**: `TicketView` over fixtures — alone at the boards'
 * inspector size (788 × 874 of the 1440 × 900 board), or in the whole Inbox page through a story
 * registry — its writes a story's spy, its draft the real store. Only stories import this.
 */

/** What a story's writes record: which lever, and what it sent. */
export type StoryWrite = { act: TicketAct; text?: string; messageId?: string };

// biome-ignore lint/a11y/useAnchorContent: the view renders its label into it
const storyLink = (path: string) => <a href={`#${path}`} onClick={(e) => e.preventDefault()} />;

function Bound({
  item,
  now,
  locked,
  pane,
  onWrite,
  narrow = false,
  clock = TICKET_NOW,
}: {
  item: TicketItem;
  now: number;
  locked: DecidedState | null;
  pane: RefObject<HTMLElement | null>;
  onWrite: (write: StoryWrite) => Promise<boolean>;
  narrow?: boolean;
  clock?: number;
}) {
  const { draft, setText, setMode, beginSend, endSend } = useTicketDraft(
    `story:${item.ticket.ticketId}`,
  );
  const [pending, setPending] = useState<TicketAct | null>(null);
  const write = (act: TicketAct, text?: string) => {
    // A reply or note goes through the ticket's own send bracket, as the handler's does.
    const clientKey =
      text !== undefined && (act === 'reply' || act === 'note') ? beginSend(act, text) : '';
    if (clientKey === null) return;
    setPending(act);
    let landed = false;
    void onWrite({ act, ...(text !== undefined && { text }) })
      .then((ok) => {
        landed = ok;
      })
      .finally(() => {
        if (text !== undefined) endSend(landed);
        setPending(null);
      });
  };
  return (
    <TicketView
      item={item}
      locked={locked}
      now={now}
      clock={clock}
      timeZone={TICKET_TZ}
      personLink={(id) => storyLink(`/admin/people/${id}`)}
      inboxAboutLink={(id) => storyLink(`/admin/inbox?about=${id}`)}
      itemLink={(ref) => storyLink(`/admin/inbox?item=${ref}`)}
      draft={draft}
      onDraftText={setText}
      onDraftMode={setMode}
      onReply={(text) => write('reply', text)}
      onNote={(text) => write('note', text)}
      onResolve={() => write('resolve')}
      onReopen={() => write('reopen')}
      onCancelReply={(messageId) => void onWrite({ act: 'cancelReply', messageId })}
      onRemoveNote={(messageId) => void onWrite({ act: 'removeNote', messageId })}
      pending={pending}
      pane={pane}
      narrow={narrow}
    />
  );
}

/** The inspector stand-in: the pane (its keys' element), the frame, at the board's size. */
export function StoryTicketInspector({
  item,
  onWrite,
  locked = null,
  width = 788,
  height = 874,
  narrow = false,
  clock,
}: {
  item: TicketItem;
  onWrite: (write: StoryWrite) => Promise<boolean>;
  locked?: DecidedState | null;
  width?: number;
  height?: number;
  narrow?: boolean;
  clock?: number;
}) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <section
      ref={pane}
      tabIndex={-1}
      aria-label="Inspector"
      data-pane="inspector"
      className="relative flex overflow-hidden bg-bg outline-none"
      style={{ width, height }}
    >
      <InspectorProvider
        value={{ pane, decidedOnOpen: false, now: TICKET_NOW, timeZone: TICKET_TZ, narrow }}
      >
        <Bound
          item={item}
          now={TICKET_NOW}
          locked={locked}
          pane={pane}
          onWrite={onWrite}
          narrow={narrow}
          {...(clock !== undefined && { clock })}
        />
      </InspectorProvider>
    </section>
  );
}

/** The handler for a story registry: the page's own inspector context gives the pane. */
export function storyTicketRegistry(
  onWrite: (write: StoryWrite) => Promise<boolean>,
): [HandlerKey, InboxHandler][] {
  const Handler: InboxHandler = ({ item, now, locked }) => {
    const { pane, narrow } = useInspectorContext();
    if (item.kind !== 'ticket') return null;
    return (
      <Bound
        item={item as unknown as TicketItem}
        now={now}
        locked={locked}
        pane={pane}
        onWrite={onWrite}
        narrow={narrow === true}
      />
    );
  };
  return [['ticket', Handler]];
}

/** A ticket's list row, as `inbox.listPage` serves it beside the item. */
export function ticketRowOf(item: TicketItem, snippet: string): InboxRowView {
  return {
    itemId: item.itemId,
    lane: item.lane,
    facet: item.facet,
    filedAt: item.filedAt,
    lastActivityAt: item.lastActivityAt,
    memberCount: item.memberCount,
    memberCountIsFloor: item.memberCountIsFloor,
    body: null,
    can: item.can,
    decided: item.decided,
    kind: 'ticket',
    category: item.ticket.category,
    person: item.person?.person ?? null,
    snippet,
  } as InboxRowView;
}
