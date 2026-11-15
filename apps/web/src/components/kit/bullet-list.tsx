import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * A short list of things to open, each on a hollow bullet (The Table's
 * vocabulary, §6): a kicker over its title, a line under. The open one is lit — the selection
 * wash, the bright rule down its left edge, the bullet filled. Where the kit's `MiddleList` is a
 * pane-sized queue, this sits inside a panel among other blocks (*Asked of this body*).
 *
 * - **One Tab stop.** A `listbox`; focus stays on it and a cursor moves through the rows
 *   (`aria-activedescendant`), so Tab goes straight on to the next pane.
 * - **↑↓ within, Home/End to the ends, typing jumps** (type-ahead on titles), and the cursor's row
 *   is scrolled into view (nearest edge, at once — never a smooth scroll, so reduced motion holds):
 *   focus stays on the list, so the browser won't reveal the row on its own. **⏎ or Space opens**
 *   the row (`onOpen`, and the caller moves focus into the right pane); a press opens it too.
 * - **A wash only because a press does something**: hover and the cursor share one quiet lift.
 *
 * Board: 5.4.1 Body | Shape (*Asked of this body*).
 */

export interface BulletListItem {
  id: string;
  kicker: ReactNode;
  /** The row's name — what type-ahead matches. */
  title: string;
  sub?: ReactNode;
}

const TYPE_AHEAD_MS = 500;

export interface BulletListProps {
  /** The list's name ("Asked of this body"). */
  label: string;
  items: readonly BulletListItem[];
  /** The open row. */
  selectedId?: string | null;
  onOpen: (id: string) => void;
  className?: string;
}

function BulletList({ label, items, selectedId = null, onOpen, className }: BulletListProps) {
  const base = useId();
  const [cursor, setCursor] = useState(0);
  const typed = useRef({ text: '', at: 0 });
  const at = Math.min(cursor, Math.max(0, items.length - 1));
  const rowId = (i: number) => `${base}-row-${i}`;
  // A keyboard move brings the cursor's row into view; a press never scrolls what was pressed.
  const moveCursor = (to: number) => {
    setCursor(to);
    document.getElementById(rowId(to))?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const move = (to: number) => {
      e.preventDefault();
      moveCursor(Math.max(0, Math.min(items.length - 1, to)));
    };
    if (e.key === 'ArrowDown') return move(at + 1);
    if (e.key === 'ArrowUp') return move(at - 1);
    if (e.key === 'Home') return move(0);
    if (e.key === 'End') return move(items.length - 1);
    // ⇧⏎ is the page's (return to the list), never an open.
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === ' ') {
      e.preventDefault();
      const item = items[at];
      if (item) onOpen(item.id);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
      const now = e.timeStamp;
      const run = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + e.key : e.key;
      typed.current = { text: run, at: now };
      const q = run.toLowerCase();
      const strip = (s: string) => s.toLowerCase().replace(/^[^a-z0-9]+/, '');
      const order = [...items.keys()].map(
        (k) => (at + (run.length === 1 ? 1 : 0) + k) % items.length,
      );
      const hit = order.find((k) => strip(items[k]?.title ?? '').startsWith(q));
      if (hit !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        moveCursor(hit);
      }
    }
  };

  return (
    <div
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={items.length > 0 ? rowId(at) : undefined}
      data-slot="bullet-list"
      onKeyDown={onKeyDown}
      className={cn('group/bl flex flex-col outline-none focus-visible:shadow-focus', className)}
    >
      {items.map((item, i) => {
        const selected = item.id === selectedId;
        return (
          // biome-ignore lint/a11y/useFocusableInteractive: an option is reached through the listbox's aria-activedescendant, never by its own focus
          // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns the keys (⏎ and Space open the cursor's row)
          <div
            key={item.id}
            id={rowId(i)}
            role="option"
            aria-selected={selected}
            data-slot="bullet-row"
            data-cursor={i === at ? '' : undefined}
            data-selected={selected ? '' : undefined}
            onClick={() => {
              setCursor(i);
              onOpen(item.id);
            }}
            className={cn(
              'relative flex cursor-pointer flex-col gap-(--space-1) py-(--space-2_5) ps-(--space-6) pe-(--space-2_5)',
              '-mx-(--space-2_5) transition-[background-color] duration-(--duration-fast) ease-standard',
              // Hover and the keyboard cursor are one look; the open row keeps its own over both.
              '[@media(hover:hover)]:not-data-selected:hover:bg-lift-05',
              'group-focus-visible/bl:not-data-selected:data-cursor:bg-lift-05',
              'data-selected:bg-lift-08 data-selected:shadow-select-rule',
            )}
          >
            <span
              aria-hidden="true"
              data-slot="bullet"
              className={cn(
                'absolute top-(--space-4) left-(--space-2_5) size-(--space-1_5) rounded-full border border-solid border-fg3',
                selected && 'border-fg bg-fg',
              )}
            />
            <span
              data-slot="bullet-kicker"
              className={cn(
                'text-kick leading-none font-medium tracking-kick text-fg3 uppercase',
                selected && 'text-fg2',
              )}
            >
              {item.kicker}
            </span>
            <span
              data-slot="bullet-title"
              className={cn(
                'text-body leading-(--lead-snug) font-medium text-fg1',
                selected && 'text-fg',
              )}
            >
              {item.title}
            </span>
            {item.sub != null && (
              <span
                data-slot="bullet-sub"
                className={cn('text-assist leading-list text-fg3', selected && 'text-fg2')}
              >
                {item.sub}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export { BulletList };
