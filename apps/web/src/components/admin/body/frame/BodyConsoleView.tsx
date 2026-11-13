import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { ConsoleStatus, ConsoleTopStart } from '../../shell/ConsoleShell';
import { BodyInspector } from './BodyInspector';
import { BodyLeftColumn, type BodyLeftColumnProps } from './BodyLeftColumn';
import type { BodyAsk } from './bodyModel';
import type { BodyTabKey } from './bodySearch';

/**
 * The Body console (`/admin/body/$id`, §5.4), drawn from props: the left column (the body), the map
 * (the instrument, full height), the inspector (the nine tabs). `BodyConsoleRoute` wires it to the
 * URL and Convex; this half takes no hook of either, so a story draws it as a board.
 *
 * - **Keys** (Round 3): Tab moves between the three panes; ↑↓ move within one (the asks list),
 *   typing jumps; ⏎ or Space on an ask opens its tab with the ask lit and **moves focus into the
 *   inspector**, where the tab's single-letter actions listen. ⇧⏎ goes back to the list the
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
  className,
  ...left
}: BodyConsoleViewProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
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
      <BodyInspector tab={tab} onTabChange={onTabChange} attention={attention} panelRef={panel}>
        {tabPanel}
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

/** The page when there is no body to show: a broken link, or a body no longer listed. */
export function BodyConsoleMissing({
  state,
  oldEditorHref,
}: {
  state: 'missing' | 'unlisted';
  oldEditorHref?: string;
}) {
  return (
    <div data-slot="body-console-missing" className="flex h-full items-start p-gutter">
      <div className="flex flex-col items-start gap-(--space-3_5)">
        <Note>
          {state === 'missing'
            ? 'No such body. The link may be broken.'
            : 'This body is unlisted: rejected, or merged into another.'}
        </Note>
        {state === 'unlisted' && oldEditorHref !== undefined && (
          <Button variant="link" size="sm" render={<a href={oldEditorHref} />}>
            Old editor →
          </Button>
        )}
      </div>
    </div>
  );
}
