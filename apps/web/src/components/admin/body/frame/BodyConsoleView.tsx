import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';
import { ConsoleStatus, ConsoleTopStart } from '../../shell/ConsoleShell';
import { BodyInspector } from './BodyInspector';
import { BodyLeftColumn, type BodyLeftColumnProps } from './BodyLeftColumn';
import type { BodyAsk } from './bodyModel';
import type { BodyTabKey } from './bodySearch';
import { useKeepFocus } from './keepFocus';
import { TabKeysProvider } from './tabKeys';

/**
 * The Body console (`/admin/body/$id`, §5.4), drawn from props: the left column (the body), the map
 * (the instrument, full height), the inspector (the nine tabs). `BodyConsoleRoute` wires it to the
 * URL and Convex; this half takes no hook of either, so a story draws it as a board.
 *
 * - **Keys** (Round 3): Tab moves between the three panes; ↑↓ move within one (the asks list),
 *   typing jumps; ⏎ or Space on an ask opens its tab with the ask lit and **moves focus into the
 *   inspector**, where the tab's single-letter actions listen — on the whole inspector, so they
 *   work from the tab strip too (`tabKeys`). Arriving at a body with nothing focused puts focus
 *   in the panel. ⇧⏎ goes back to the list the
 *   operator came from. ⌘K and G-then-a-letter are the shell's.
 * - **The status bar** says when the record was last re-affirmed by a campaign; **the top bar**
 *   carries the way back to the list.
 */

export type BodyConsoleViewProps = Omit<BodyLeftColumnProps, 'onOpenAsk' | 'className'> & {
  tab: BodyTabKey;
  onTabChange: (tab: BodyTabKey) => void;
  /** An ask opened: its tab, with it lit. */
  onOpenAsk: (ask: BodyAsk) => void;
  /** Tabs that wear the amber square. */
  attention: ReadonlySet<BodyTabKey>;
  /** The open tab's content. */
  tabPanel: ReactNode;
  /** The map pane. */
  map: ReactNode;
  /** ⇧⏎ and the top bar's place control: back to the list. */
  onReturn?: () => void;
  /** The status bar's line ("Last campaign 12 Oct"); none when there is nothing to say. */
  status?: string | null;
  /**
   * The body on screen: a new one is an arrival (the list's Open, a deep link, a neighbor's link),
   * and the open tab's keys must work from it.
   */
  bodyKey?: string;
  className?: string;
};

export function BodyConsoleView({
  tab,
  onTabChange,
  onOpenAsk,
  attention,
  tabPanel,
  map,
  onReturn,
  status = null,
  bodyKey,
  className,
  ...left
}: BodyConsoleViewProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const inspector = useRef<HTMLDivElement | null>(null);
  // A write that settles never drops the keyboard to the page: focus comes back to the panel.
  useKeepFocus(panel);
  // Arriving at a body with nothing focused (the list's Open, a deep link): focus goes to the
  // panel, so the open tab's keys work at once. A neighbor's link pressed in a tab counts as nothing
  // focused: its row is the old body's and leaves with it. Focus somewhere that stays (the tab strip,
  // the left column) stays where it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: an arrival is a new body
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) panel.current?.focus({ preventScroll: true });
  }, [bodyKey]);
  // **A tab change, or a new body, restores the panel's defaults**: it opens at its top, never at
  // the last tab's scroll. (The map's switches follow the same rule, in `BodyMap`.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroll belongs to the tab and body
  useLayoutEffect(() => {
    if (panel.current !== null) panel.current.scrollTop = 0;
  }, [tab, bodyKey]);
  // A press on an ask asks for focus in the inspector; it moves once the tab has rendered.
  const [focusRight, setFocusRight] = useState(0);
  useEffect(() => {
    if (focusRight > 0) panel.current?.focus();
  }, [focusRight]);

  usePaneKeys(root, [
    {
      key: 'Shift+Enter',
      label: 'Back to the list',
      enabled: onReturn !== undefined,
      run: () => onReturn?.(),
    },
  ]);

  return (
    <div
      ref={root}
      data-slot="body-console"
      className={cn(
        'grid h-full min-h-0 grid-cols-[var(--size-list)_minmax(0,1fr)_var(--size-inspector)]',
        className,
      )}
    >
      <BodyLeftColumn
        {...left}
        onOpenAsk={(ask) => {
          onOpenAsk(ask);
          setFocusRight((n) => n + 1);
        }}
      />
      <div data-slot="body-map-column" className="relative min-h-0 min-w-0">
        {map}
      </div>
      <BodyInspector
        tab={tab}
        onTabChange={onTabChange}
        attention={attention}
        panelRef={panel}
        inspectorRef={inspector}
      >
        <TabKeysProvider inspector={inspector}>{tabPanel}</TabKeysProvider>
      </BodyInspector>
      {onReturn !== undefined && (
        <ConsoleTopStart>
          <Button variant="outline" size="sm" onClick={onReturn} aria-keyshortcuts="Shift+Enter">
            Bodies
          </Button>
        </ConsoleTopStart>
      )}
      {status !== null && <ConsoleStatus groups={[<span key="campaign">{status}</span>]} />}
    </div>
  );
}

/**
 * The page when there is no body to show: a broken link, or the body's own read failed (with *Try
 * again*, which reads it again). A body that was removed or merged is `BodyConsoleGone`.
 */
export function BodyConsoleMissing(
  props: { state: 'missing' } | { state: 'failed'; onRetry: () => void },
) {
  return (
    <div data-slot="body-console-missing" className="flex h-full items-start p-gutter">
      <div className="flex max-w-(--size-inspector) flex-col items-start gap-(--space-3_5)">
        {props.state === 'missing' ? (
          <Note>No such body. The link may be broken.</Note>
        ) : (
          <RetryNote data-for="body-console" onRetry={props.onRetry}>
            This body couldn’t be read
          </RetryNote>
        )}
      </div>
    </div>
  );
}
