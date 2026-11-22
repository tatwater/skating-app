import { type ReactElement, useState } from 'react';

import { StatusLamp } from '@/components/kit/status-bar';

import { ConsoleShell } from '../shell/ConsoleShell';
import { CONSOLE_MODES, LEGACY_PAGES } from '../shell/consoleNav';
import { seasonTape } from '../shell/consoleTime';
import { InboxView, type InboxViewProps } from './InboxView';
import type { InboxQuery } from './inboxSearch';
import type { InspectorState } from './inspector/InboxInspector';
import { inboxRailCount } from './lanes/laneModel';
import { LANES, NOW } from './list/inboxFixtures';
import type { InboxItemView } from './list/inboxTypes';

/**
 * **Story support: the Inbox in the console's frame** — the real shell (`ConsoleShell`, drawn from
 * props) around `InboxView`, at the boards' 1440 × 900 on the pinned clock, holding the page's place
 * itself so a story's keys and presses move it as the route would: a lane, a tab, a filter, an item
 * opened (from `items`, by id) and closed. Only stories import it.
 */

const TAPE = seasonTape(NOW, 'America/New_York');

/** A story's anchor for a console path: a link that goes nowhere. */
export const storyLink = (path: string): ReactElement => (
  // biome-ignore lint/a11y/useAnchorContent: the caller renders its label into it
  <a href={`#${path}`} onClick={(e) => e.preventDefault()} />
);

export type InboxBoardProps = Omit<
  InboxViewProps,
  | 'query'
  | 'onQueryChange'
  | 'inspector'
  | 'onOpenItem'
  | 'onCloseItem'
  | 'now'
  | 'linkFor'
  | 'lanes'
> & {
  initialQuery: InboxQuery;
  /** The lanes read; `undefined` while it hasn't answered. */
  lanes?: InboxViewProps['lanes'];
  /** The items a row opens, by item id; a row with none opens *No such item*. */
  items?: Readonly<Record<string, InboxItemView>>;
  /** What the inspector shows for the open item, overriding `items` (loading, failed, a lock). */
  inspector?: InspectorState;
  /** Heard on every change of place and every item opened, for a story's assertions. */
  onQueryChange?: (next: InboxQuery) => void;
  onOpenItem?: InboxViewProps['onOpenItem'];
  /** The frame's size; the boards' 1440 × 900 by default. */
  className?: string;
};

export function InboxBoard({
  initialQuery,
  lanes = LANES,
  items = {},
  inspector,
  onQueryChange,
  onOpenItem,
  className = 'h-[56.25rem] w-[90rem]',
  ...view
}: InboxBoardProps) {
  const [query, setQuery] = useState(initialQuery);
  const open = query.item === null ? undefined : items[query.item];
  const state: InspectorState =
    inspector ??
    (query.item === null
      ? { kind: 'none' }
      : open === undefined
        ? { kind: 'missing' }
        : { kind: 'item', item: open, phase: open.decided === null ? 'live' : 'onOpen' });
  return (
    <ConsoleShell
      className={className}
      modes={CONSOLE_MODES.map((m) => ({
        ...m,
        current: m.id === 'inbox',
        ...(m.id === 'inbox' && inboxRailCount(lanes)),
      }))}
      legacy={LEGACY_PAGES}
      onLegacy={() => {}}
      linkFor={storyLink}
      appHref="#app"
      viewer={{ name: 'Teagan Atwater' }}
      tape={TAPE}
      colleagues={[
        { id: 's', name: 'Sarah Berman', present: true },
        { id: 'm', name: 'Matt Steinberg' },
      ]}
      viewerId="t"
      onSearch={() => {}}
      lamp={<StatusLamp>Convex live</StatusLamp>}
    >
      <InboxView
        {...view}
        lanes={lanes}
        query={query}
        onQueryChange={(next) => {
          onQueryChange?.(next);
          setQuery(next);
        }}
        inspector={state}
        onOpenItem={(id, from) => {
          onOpenItem?.(id, from);
          setQuery((q) => ({ ...q, item: id }));
          if (from === 'keys') {
            document
              .querySelector<HTMLElement>('[data-slot="inbox-page"] > [data-pane="detail"]')
              ?.focus();
          }
        }}
        onCloseItem={() => setQuery((q) => ({ ...q, item: null }))}
        now={NOW}
        linkFor={storyLink}
      />
    </ConsoleShell>
  );
}
