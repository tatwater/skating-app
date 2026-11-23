import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';
import { ConsoleStatus, ConsoleTopStart } from '../../shell/ConsoleShell';
import { useColumnsFit, usePaneFocus } from '../../shell/columnsFit';
import { PANE_WORDS } from '../consoleWords';
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
 * - **A narrow screen** (the console's one rule, `useColumnsFit`: the three columns while the left
 *   column, a lanes column's worth of map and the inspector fit side by side — the Bodies library's
 *   own sum) shows **one pane at a time**: the body first, then the map or the tab, each pane
 *   heading with buttons to the other two. Opening an ask goes to its tab. Every pane stays mounted,
 *   hidden, so nothing in one is lost by going to another, and focus moves with the pane
 *   (`usePaneFocus`). The map is mounted the first time it is shown and kept from then on: never
 *   created into a pane with no size, never re-created by a switch.
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

/**
 * The three columns' width tokens: the left column, a lanes column's worth of map, the inspector —
 * the same sum as the Bodies library's three, so both pages turn narrow at one width.
 */
const COLUMNS = ['--size-list', '--size-lanes', '--size-inspector'] as const;

/** The pane a narrow page shows. */
type NarrowPane = 'body' | 'map' | 'tab';

/** Each pane's way there, as a narrow pane's head says it. */
const TO_PANE: Record<NarrowPane, string> = {
  body: PANE_WORDS.toBody,
  map: PANE_WORDS.toMap,
  tab: PANE_WORDS.toTab,
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
  const leftPane = useRef<HTMLElement | null>(null);
  const mapPane = useRef<HTMLElement | null>(null);

  // The console's narrow rule: the three columns while they fit, else one pane at a time.
  const narrow = !useColumnsFit(root, COLUMNS);
  // Each body opens on its front — or, arriving with an item lit (a task, a deep link), on its tab.
  // Held per body: another body is a fresh page.
  const arrival: NarrowPane = left.lit !== null ? 'tab' : 'body';
  const [narrowPane, setNarrowPane] = useState<{ body: string | undefined; at: NarrowPane }>({
    body: bodyKey,
    at: arrival,
  });
  const at = narrowPane.body === bodyKey ? narrowPane.at : arrival;
  if (narrowPane.body !== bodyKey) setNarrowPane({ body: bodyKey, at });
  const shown = !narrow ? 'all' : at === 'body' ? 'list' : 'detail';
  const panes = usePaneFocus({
    page: root,
    shown,
    // The body is always open: there is no list to fall back to beside the columns.
    open: true,
    focusList: () => leftPane.current?.focus({ preventScroll: true }),
    detailPane: at === 'map' ? 'map' : 'inspector',
    listPanes: ['body'],
  });
  const goTo = (next: NarrowPane) => {
    if (next === 'body') panes.askBack();
    setNarrowPane({ body: bodyKey, at: next });
  };

  // **The map is mounted once it is first shown, and kept**: never created into a pane that has no
  // size (it would frame the body at a zoom for nothing), never re-created by a switch. Until the
  // page is measured, it isn't known whether the map is shown.
  const [measured, setMeasured] = useState(false);
  useLayoutEffect(() => setMeasured(true), []);
  const mapShown = measured && (!narrow || at === 'map');
  const [mapKept, setMapKept] = useState(false);
  if (mapShown && !mapKept) setMapKept(true);

  // A write that settles never drops the keyboard to the page: focus comes back to the panel.
  useKeepFocus(panel);
  // Arriving at a body with nothing focused (the list's Open, a deep link): focus goes to the
  // panel, so the open tab's keys work at once — or, on a narrow page, to the pane on screen. A
  // neighbor's link pressed in a tab counts as nothing focused: its row is the old body's and leaves
  // with it. Focus somewhere that stays (the tab strip, the left column) stays where it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: an arrival is a new body
  useEffect(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target = !narrow || at === 'tab' ? panel : at === 'map' ? mapPane : leftPane;
    target.current?.focus({ preventScroll: true });
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
      data-narrow={narrow ? '' : undefined}
      data-pane-shown={narrow ? at : undefined}
      {...panes.pageProps}
      className={cn(
        'h-full min-h-0',
        narrow
          ? 'flex flex-col overflow-x-hidden'
          : 'grid grid-cols-[var(--size-list)_minmax(0,1fr)_var(--size-inspector)]',
        className,
      )}
    >
      <BodyLeftColumn
        // A body's own: the boost under the hand, the asks' cursor, History's place — none of it
        // carries to the next body.
        key={bodyKey}
        {...left}
        paneRef={leftPane}
        nav={narrow && <PaneNav to={['map', 'tab']} onGo={goTo} />}
        className={cn(narrow && cn('flex-1 border-r-0', at !== 'body' && 'hidden'))}
        onOpenAsk={(ask) => {
          onOpenAsk(ask);
          if (narrow) goTo('tab');
          setFocusRight((n) => n + 1);
        }}
      />
      <section
        ref={mapPane}
        data-slot="body-map-column"
        data-pane="map"
        tabIndex={-1}
        aria-label={PANE_WORDS.map}
        className={cn(
          'flex min-h-0 min-w-0 flex-col outline-none',
          'focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
          narrow && cn('flex-1', at !== 'map' && 'hidden'),
        )}
      >
        {narrow && <PaneNav to={['body', 'tab']} onGo={goTo} />}
        <div data-slot="body-map-frame" className="relative min-h-0 flex-1">
          {mapKept || mapShown ? map : null}
        </div>
      </section>
      <BodyInspector
        tab={tab}
        onTabChange={onTabChange}
        attention={attention}
        panelRef={panel}
        inspectorRef={inspector}
        nav={narrow && <PaneNav to={['body', 'map']} onGo={goTo} />}
        className={cn(narrow && cn('flex-1 border-l-0', at !== 'tab' && 'hidden'))}
      >
        <TabKeysProvider inspector={inspector}>{tabPanel}</TabKeysProvider>
      </BodyInspector>
      {onReturn !== undefined && (
        <ConsoleTopStart>
          <Button variant="outline" size="sm" onClick={onReturn} aria-keyshortcuts="Shift+Enter">
            Corpus
          </Button>
        </ConsoleTopStart>
      )}
      {status !== null && <ConsoleStatus groups={[<span key="campaign">{status}</span>]} />}
    </div>
  );
}

/**
 * A narrow pane's head: its way to the other two panes — back to the body, or on to the map or the
 * tab — as the Bodies library's *Back to the list* is drawn.
 */
function PaneNav({ to, onGo }: { to: readonly NarrowPane[]; onGo: (pane: NarrowPane) => void }) {
  return (
    <div
      data-slot="body-pane-nav"
      className="flex shrink-0 flex-wrap gap-(--space-2) border-0 border-b border-solid border-line px-gutter py-(--space-2)"
    >
      {to.map((pane) => (
        <Button key={pane} size="xs" onClick={() => onGo(pane)}>
          {TO_PANE[pane]}
        </Button>
      ))}
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
