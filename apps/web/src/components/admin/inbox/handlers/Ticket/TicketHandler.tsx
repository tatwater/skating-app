import { type RefObject, useCallback, useEffect, useState } from 'react';
import { type InboxQuery, inboxHref } from '../../inboxSearch';
import type { InboxHandlerProps } from '../../inspector/handlerRegistry';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { TicketView } from './TicketView';
import { useTicketDraft } from './ticketDrafts';
import { anySettling, type DockMode, type TicketItem } from './ticketModel';
import { useTicketServer, useTicketWrites } from './useTicketWrites';

/**
 * **The ticket handler** (board 2.8), registered for the `ticket` key (`register.tsx`): the item
 * drawn by `TicketView`, its writes bound (`useTicketWrites` → `support.reply`, `addNote`,
 * `resolve`, `reopen`, `removeNote`, `cancelReply` — each drawn only where the server's answer
 * allows it, a refusal in the server's words), the draft kept by ticket
 * (`ticketDrafts`), and the links through the inspector's router.
 *
 * **Focus after a write** (the console's rule: never left on the page's body). A resolve is a
 * decision, which the Inbox's view already follows (the next row, or the inspector under a lock).
 * A note, a reply, a cancel or a reopen leaves focus where it was; when the control that held it
 * is gone (*Cancel* once the reply is canceled, *Reopen* once reopened), the inspector pane takes
 * it, where the item's keys act.
 */
/** The Inbox's All open list, the place a Related link starts from. */
const ALL_OPEN: InboxQuery = { lane: 'all', facet: 'all', filter: null, item: null, from: null };

export function TicketHandler({ item, locked, now }: InboxHandlerProps) {
  // The registry hands this handler only `ticket` items (its one key).
  const ticket = item as TicketItem;
  const { pane, timeZone, linkFor, narrow } = useInspectorContext();
  const server = useTicketServer();
  const writes = useTicketWrites(ticket, server);
  const { draft, setText, setMode, beginSend, endSend } = useTicketDraft(ticket.ticket.ticketId);
  const clock = useSecondClock(anySettling(ticket));
  const keepFocus = useKeepFocusIn(pane);
  const send = useCallback(
    async (
      mode: DockMode,
      write: (body: string, clientKey: string) => Promise<boolean>,
      body: string,
    ) => {
      // One send out per ticket, wherever its dock is drawn (the store's, not this handler's, which
      // remounts as the inspector moves): a second press, here or after coming back, sends nothing.
      const clientKey = beginSend(mode, body);
      if (clientKey === null) return;
      let landed = false;
      try {
        landed = await write(body, clientKey);
      } finally {
        // Landed, the words that went are cleared; refused, every word stays, with the press's key.
        endSend(landed);
      }
      keepFocus();
    },
    [beginSend, endSend, keepFocus],
  );
  const link = (path: string) =>
    // biome-ignore lint/a11y/useAnchorContent: the view renders its label into it
    linkFor?.(path) ?? <a href={path} />;
  return (
    <TicketView
      item={ticket}
      locked={locked}
      now={now}
      clock={clock}
      {...(timeZone !== undefined && { timeZone })}
      personLink={(id) => link(`/admin/people/${encodeURIComponent(id)}`)}
      itemLink={(ref) => link(inboxHref({ ...ALL_OPEN, item: ref }))}
      inboxAboutLink={(id) => link(inboxHref({ ...ALL_OPEN, filter: { kind: 'about', id } }))}
      draft={draft}
      onDraftText={setText}
      onDraftMode={setMode}
      onReply={(text) => void send('reply', writes.reply, text)}
      onNote={(text) => void send('note', writes.note, text)}
      onResolve={() => void writes.resolve()}
      onReopen={() => void writes.reopen().then(keepFocus)}
      onCancelReply={(messageId) => void writes.cancelReply(messageId).then(keepFocus)}
      onRemoveNote={(messageId) => void writes.removeNote(messageId).then(keepFocus)}
      pending={writes.pending}
      pane={pane}
      narrow={narrow === true}
    />
  );
}

/** A clock that ticks each second while `on` (a reply counting down), else holds still. */
function useSecondClock(on: boolean): number {
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setAt(Date.now());
    const id = setInterval(() => setAt(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return at;
}

/**
 * After a write: if focus fell to the page (the control that held it went with the item's change),
 * the pane takes it. Checked over two frames, as the item's read redraws after the write answers.
 */
function useKeepFocusIn(pane: RefObject<HTMLElement | null>): () => void {
  return useCallback(() => {
    let frames = 0;
    const check = () => {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        pane.current?.focus({ preventScroll: true });
        return;
      }
      if (++frames < 3) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, [pane]);
}
