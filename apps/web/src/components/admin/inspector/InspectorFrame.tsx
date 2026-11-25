import { type ReactNode, useEffect, useRef } from 'react';

import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { DecidedLock } from './DecidedLock';
import { useInspectorContext } from './inspectorContext';

/**
 * **The inspector's frame** — every Inbox handler draws inside it, and from B01-6a every Corpus task
 * handler too (moved here from `inbox/inspector/` then; the canonical seam: handlers import it by
 * this signature; its props change only with the governor's word). From the boards (2.1–2.8,
 * `.inspector`): the pane head (36 px: the item's kicker, its chips, its age written
 * out, a link at its end), the scroll, and the floating action bar at the pane's foot.
 *
 * - **`head`** — the pane head's contents, left to right; `InspectorHeadEnd` pushes a link to its
 *   end. A head never repeats what the pane shows (the second pass).
 * - **`actions`** — the action bar: the kit's `ActionBar`, which floats itself at this frame's foot
 *   (tight to its buttons, 8 px clear of the status bar and both sides; the frame is its positioned
 *   pane). The scroll then keeps 80 px of room at its end so the last line clears it (the Inbox
 *   pass); with no actions it ends in the console's ~56 px.
 * - **`fill`** — the body fills the scroll to its foot and scrolls itself (board 2.8's two columns,
 *   whose thread scrolls above its dock and whose side carries its own bar): the frame leaves no end
 *   room under it.
 * - **`locked`** — the item's decision, when it has one. The action bar goes (a decided item takes
 *   no verb), and a banner says who decided it, when and what, with *History →* and *Back to the
 *   queue* (⏎) — unless the viewer decided it themselves while it was open here, which clears
 *   quietly (D283; the inspector's context says which).
 *
 * The frame takes no Convex and no router: the inspector column's context (`InspectorProvider`)
 * gives it the way back, the history link, the clock and the pane its keys bind to.
 */

/**
 * Who decided an item, when and what — the lock's facts, as every handler receives them. The
 * decision arrives already in its mode's words (the Inbox maps its `DECISION_WORDS` in
 * `inbox/inspector/inboxLock.ts`), so the frame says it without knowing whose decisions they are.
 */
export type DecidedState = {
  /** The decider's real name. */
  by: string;
  at: number;
  /** The decision as the lock's line says it: "approved", "no public access". */
  decisionWord: string;
  /** The viewer decided it. */
  byMe: boolean;
  /** The audit row the decision wrote (`''` for a decision recorded before the Inbox). */
  actionId: string;
};

export function InspectorFrame({
  head,
  actions,
  locked,
  fill = false,
  children,
}: {
  head: ReactNode;
  actions?: ReactNode;
  locked?: DecidedState | null;
  fill?: boolean;
  children: ReactNode;
}) {
  const { pane, onBack, history, decidedOnOpen, now, timeZone } = useInspectorContext();
  const decided = locked != null;
  // The viewer's own decision, made while the item was open here, clears quietly (they know).
  const banner = decided && (decidedOnOpen || !locked.byMe);
  const bar = !decided && actions != null;
  // ⏎ while the lock stands goes back to the queue — the banner's button wears it. (A button or a
  // field with focus keeps its own Enter: the pane's keys never take a control's key.)
  // A held ⏎ repeats: only its first press acts, or a held key that opened a decided item from the
  // list would bounce straight back to it and on, list and inspector by turns. The pane's own
  // capture listener reads each keydown's `repeat` before the key binding runs.
  const repeat = useRef(false);
  useEffect(() => {
    const el = pane.current;
    if (el === null) return;
    const read = (event: KeyboardEvent) => {
      repeat.current = event.repeat;
    };
    el.addEventListener('keydown', read, true);
    return () => el.removeEventListener('keydown', read, true);
  }, [pane]);
  usePaneKeys(pane, [
    {
      key: 'Enter',
      run: () => {
        if (!repeat.current) onBack?.();
      },
      enabled: banner && onBack !== undefined,
    },
  ]);

  return (
    <div
      data-slot="inbox-inspector-frame"
      data-locked={decided ? '' : undefined}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header
        data-slot="inbox-inspector-head"
        // The board's 36 px head (a token sum; the console has no pane-head token, reported) on one
        // line while it fits. Narrower (a phone's page), it wraps rather than clip: the title, the
        // age and the links each stay whole, the links still at the line's end.
        className={cn(
          'flex min-h-[calc(var(--space-8)+var(--space-1))] min-w-0 shrink-0 flex-wrap items-center',
          'gap-x-(--space-2_5) gap-y-(--space-1_5) py-(--space-1_5)',
          'border-0 border-b border-solid border-line px-gutter',
        )}
      >
        {head}
      </header>
      {banner && (
        <div data-slot="inbox-inspector-lock" className="shrink-0 px-gutter pt-(--space-3_5)">
          <DecidedLock
            locked={locked}
            now={now}
            timeZone={timeZone}
            history={history}
            onBack={onBack}
          />
        </div>
      )}
      <div
        data-slot="inbox-inspector-scroll"
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain',
          fill ? 'flex flex-col' : bar ? 'pb-(--space-20)' : 'pb-(--space-14)',
        )}
        data-fill={fill ? '' : undefined}
      >
        {children}
      </div>
      {/* The kit's ActionBar floats itself at this (positioned) frame's foot. */}
      {bar && actions}
    </div>
  );
}

/** The pane head's kicker: the item's kind, lit (the board's `.kick.lit` at 12 px). */
export function InspectorHeadTitle({ children }: { children: ReactNode }) {
  return (
    <h2
      data-slot="inbox-inspector-title"
      className="m-0 shrink-0 text-assist leading-none font-medium tracking-kick whitespace-nowrap text-fg uppercase"
    >
      {children}
    </h2>
  );
}

/** The pane head's age, written out ("4 days ago"; a list row keeps "4 d"). */
export function InspectorHeadAge({ children }: { children: ReactNode }) {
  return (
    <span
      data-slot="inbox-inspector-age"
      className="min-w-0 text-kick leading-(--lead-snug) font-medium tracking-kick text-fg3 uppercase"
    >
      {children}
    </span>
  );
}

/** The pane head's end: a link ("Open in Reports →") or two, pushed right. */
export function InspectorHeadEnd({ children }: { children: ReactNode }) {
  return (
    <span
      data-slot="inbox-inspector-head-end"
      className="ms-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-(--space-2_5)"
    >
      {children}
    </span>
  );
}
