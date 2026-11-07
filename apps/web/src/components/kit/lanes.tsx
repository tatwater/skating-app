import { useRender } from '@base-ui/react/use-render';
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

/**
 * The lanes sidebar (admin only): the middle column's list of lanes — it picks **which list** the
 * page shows (a queue, a subject, a view; one at a time). A facet that narrows the list on screen
 * is a row of tabs over that list, never a lane.
 *
 * - **Group kickers** in caps over their lanes; a group's lanes are a list named by its kicker.
 * - **A lane row** is the lane step tall (28 px on the console): its name in the row step, the
 *   quiet-bright ink; an optional tail (a catalog tag, a solid status badge) and the **count** in
 *   mono at the row's end — quiet, lit (`lit`), amber or red by meaning.
 * - **On** (the selected lane): the bright ink on the lit plate, with the 2 px bar inset on its left
 *   edge. **Dim**: a lane with nothing in it, in the quiet ink — still a lane you can open.
 * - **Keyboard**: one tab stop (the selected lane); ↑ ↓ move between lanes across groups, Home and
 *   End jump to the ends, and typing jumps to the next lane that starts with what you typed (a
 *   letter pressed again cycles through the lanes starting with it). Enter (or a click) picks the
 *   lane. Keys it handles are marked handled (`preventDefault`), so the page's hotkeys leave them
 *   alone — typing in the lanes never fires an action.
 * - **No tooltips** — this is navigation; a lane that needs explaining is renamed.
 * - **Routing is the caller's**: `link(lane)` returns the router's link element for a lane and the
 *   row renders as it; without it, each row is a button. Either way, `onSelect` hears the pick.
 * - Anything that isn't navigation (a progress lockup, a status note) docks to the `foot`, over a
 *   hairline.
 */

type LaneCountTone = 'default' | 'lit' | 'warn' | 'bad';

type Lane = {
  id: string;
  /** The lane's name, written capitalized ("Cost ledger"). */
  label: string;
  /** How many are in it ("3", "$75.80", "1.2k"). */
  count?: number | string;
  /** The count's ink: quiet, lit, amber (needs a person) or red (failed). */
  countTone?: LaneCountTone;
  /** Nothing in it: the quiet ink. Still a lane you can open. */
  dim?: boolean;
  /** Before the count: a catalog tag, or a solid status badge beside the lane ("Open"). */
  tail?: ReactNode;
};

type LaneGroup = {
  /** The group's kicker ("Pipelines"). A group without one is the sidebar's lead lanes. */
  label?: string;
  lanes: readonly Lane[];
};

type LanesProps = Omit<ComponentProps<'nav'>, 'children' | 'onSelect'> & {
  /** What the lanes choose between ("Machinery"): the navigation's name. */
  label: string;
  groups: readonly LaneGroup[];
  /** The lane on screen. */
  selected?: string;
  /** A lane was picked (clicked, or Enter on it). */
  onSelect?: (id: string) => void;
  /** The router's link for a lane (`(lane) => <Link to={…} />`); rows are buttons without it. */
  link?: (lane: Lane) => ReactElement;
  /** Not navigation: docked to the sidebar's foot, over a hairline. */
  foot?: ReactNode;
};

const COUNT_TONE: Record<LaneCountTone, string> = {
  default: 'text-fg3',
  lit: 'text-fg',
  warn: 'text-warn',
  bad: 'text-bad',
};

/** How long typed letters keep adding to one search before it starts over. */
const TYPEAHEAD_MS = 500;

function Lanes({
  label,
  groups,
  selected,
  onSelect,
  link,
  foot,
  className,
  onKeyDown,
  ...props
}: LanesProps) {
  const baseId = useId();
  const all = groups.flatMap((g) => g.lanes);
  const rows = useRef(new Map<string, HTMLElement>());
  const typed = useRef({ text: '', at: 0 });
  // The tab stop: the lane last focused, else the selected lane, else the first.
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const stop =
    [focused, selected].find((id) => id !== undefined && all.some((l) => l.id === id)) ??
    all[0]?.id;

  const focusLane = (id: string | undefined) => {
    if (id === undefined) return;
    rows.current.get(id)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const at = all.findIndex((l) => rows.current.get(l.id) === document.activeElement);
    if (at === -1) return;
    const move = (to: number) => {
      event.preventDefault();
      focusLane(all[Math.max(0, Math.min(all.length - 1, to))]?.id);
    };
    if (event.key === 'ArrowDown') return move(at + 1);
    if (event.key === 'ArrowUp') return move(at - 1);
    if (event.key === 'Home') return move(0);
    if (event.key === 'End') return move(all.length - 1);
    if (event.key.length !== 1 || event.key === ' ') return;
    const now = event.timeStamp;
    const running = typed.current.text !== '' && now - typed.current.at <= TYPEAHEAD_MS;
    // G and ? belong to the keyboard layer (go-mode, the key sheet) unless a type-ahead run is
    // under way — the same rule as the middle list, so go-mode opens from a focused lane.
    if (!running && /^[g?]$/i.test(event.key)) return;
    // Type-ahead: letters typed close together build one search; a fresh letter starts over.
    event.preventDefault();
    const text = running ? typed.current.text + event.key : event.key;
    typed.current = { text, at: now };
    const lower = text.toLocaleLowerCase();
    // A run of one letter ("rrr") is that letter pressed again, not a search for "rrr": it cycles
    // through the lanes starting with it — the middle list's rule. A mixed run is a prefix search.
    const repeat = lower.length > 1 && [...lower].every((c) => c === lower[0]);
    const query = repeat ? lower.charAt(0) : lower;
    // One letter (or a run of it) looks past the current lane, so pressing it again cycles; a
    // longer search keeps the current lane while it still matches.
    const from = query.length === 1 ? at + 1 : at;
    const order = [...all.slice(from), ...all.slice(0, from)];
    const hit = order.find((l) => l.label.toLocaleLowerCase().startsWith(query));
    if (hit !== undefined) focusLane(hit.id);
  };

  return (
    <nav
      aria-label={label}
      data-slot="lanes"
      className={cn('flex h-full min-h-0 w-full flex-col pt-(--space-3_5)', className)}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <div data-slot="lanes-groups" className="flex min-h-0 flex-col gap-(--space-0_5)">
        {groups.map((group, g) => {
          const kickerId = `${baseId}-${g}`;
          return (
            <div
              // Groups are positional: the sidebar's layout.
              // biome-ignore lint/suspicious/noArrayIndexKey: a group's place is its identity.
              key={g}
              data-slot="lanes-group"
              className="flex flex-col gap-(--space-0_5)"
            >
              {group.label !== undefined && (
                <div
                  id={kickerId}
                  data-slot="lanes-kicker"
                  className={cn(
                    'px-(--space-4_5) pb-(--space-1_5) text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase',
                    g > 0 && 'pt-(--space-3)',
                  )}
                >
                  {group.label}
                </div>
              )}
              <ul
                aria-labelledby={group.label !== undefined ? kickerId : undefined}
                className="m-0 flex list-none flex-col gap-(--space-0_5) p-0"
              >
                {group.lanes.map((lane) => (
                  <li key={lane.id} className="flex">
                    <LaneRow
                      lane={lane}
                      on={lane.id === selected}
                      tabbable={lane.id === stop}
                      linked={link !== undefined}
                      render={link?.(lane)}
                      rowRef={(el) => {
                        if (el === null) rows.current.delete(lane.id);
                        else rows.current.set(lane.id, el);
                      }}
                      onFocus={() => setFocused(lane.id)}
                      onClick={() => onSelect?.(lane.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {foot !== undefined && (
        <div
          data-slot="lanes-foot"
          className="mt-auto border-0 border-t border-solid border-line px-(--space-4_5) py-(--space-3) text-assist leading-(--lead-list) text-fg3"
        >
          {foot}
        </div>
      )}
    </nav>
  );
}

type LaneRowProps = {
  lane: Lane;
  on: boolean;
  tabbable: boolean;
  linked: boolean;
  render: ReactElement | undefined;
  rowRef: (el: HTMLElement | null) => void;
  onFocus: () => void;
  onClick: () => void;
};

function LaneRow({ lane, on, tabbable, linked, render, rowRef, onFocus, onClick }: LaneRowProps) {
  const tone = on ? 'lit' : (lane.countTone ?? 'default');
  const hasCount = lane.count !== undefined && lane.count !== '';
  return useRender({
    defaultTagName: 'button',
    render,
    ref: rowRef,
    props: {
      ...(linked ? {} : { type: 'button' as const }),
      tabIndex: tabbable ? 0 : -1,
      'aria-current': on ? (linked ? 'page' : 'true') : undefined,
      onFocus,
      onClick,
      className: cn(
        'flex h-lane w-full min-w-0 items-center gap-(--space-2) px-(--space-4_5) text-left outline-none select-none',
        'border-0 bg-transparent no-underline',
        'text-row leading-none font-regular whitespace-nowrap text-fg2',
        'transition-[background-color,color] duration-(--duration-fast) ease-standard',
        // The wash: a lane is clickable, so it may wash on hover (and on focus — one look).
        'lit:bg-lift-05 lit:text-fg1 focus-visible:inset-ring-1 focus-visible:inset-ring-fg',
        lane.dim && !on && 'text-fg3',
        // On: the lit plate and the 2 px bar inset on the left edge.
        on && 'bg-lift-08 text-fg shadow-select-rule lit:bg-lift-08 lit:text-fg',
      ),
      children: (
        <>
          <span data-slot="lane-label" className="min-w-0 truncate">
            {lane.label}
          </span>
          {(lane.tail !== undefined || hasCount) && (
            <span className="ml-auto flex shrink-0 items-center gap-(--space-2)">
              {lane.tail}
              {hasCount && (
                <span
                  data-slot="lane-count"
                  data-tone={tone}
                  className={cn(
                    'font-(family-name:--family-mono) text-mono-sm leading-none font-medium tabular-nums',
                    COUNT_TONE[tone],
                  )}
                >
                  {lane.count}
                </span>
              )}
            </span>
          )}
        </>
      ),
    },
    state: { slot: 'lane', on, dim: lane.dim === true },
  });
}

export { type Lane, type LaneGroup, Lanes, type LanesProps };
