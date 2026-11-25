import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { useRender } from '@base-ui/react/use-render';
import {
  type ComponentProps,
  Fragment,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { Collapsible, CollapsibleChevron, CollapsibleContent } from './collapsible';
import { LANE_DRESSES, type LaneDress } from './lane-dress';

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
 *   edge; a quiet count lights with it, an amber or red one keeps its meaning. **Dim**: a lane with
 *   nothing in it, in the quiet ink — still a lane you can open.
 * - **Keyboard**: one tab stop (the selected lane); ↑ ↓ move between lanes across groups, Home and
 *   End jump to the ends, and typing jumps to the next lane that starts with what you typed (a
 *   letter pressed again cycles through the lanes starting with it). Enter (or a click) picks the
 *   lane. Keys it handles are marked handled (`preventDefault`), so the page's hotkeys leave them
 *   alone — typing in the lanes never fires an action.
 * - **No tooltips** — this is navigation; a lane that needs explaining is renamed.
 * - **Routing is the caller's**: `link(lane)` returns the router's link element for a lane and the
 *   row renders as it; without it, each row is a button. Either way, `onSelect` hears the pick.
 * - Anything that isn't navigation (a progress lockup, a status note) docks to the `foot`, over a
 *   hairline. What belongs to **one group** (the pass's meter and its line) docks to that group's
 *   own `foot`, under its lanes, in small type.
 * - **A dressed group** (`dress`, see `lane-dress.tsx`) is set apart from the others — the seasonal
 *   Pre-Season Pass while it waits on a person. Its kicker, names and counts keep the column's
 *   18 px line.
 * - **A collapsible group** (`collapsible`, the caller's open state) folds to **one plain line** —
 *   the pass once it is done, kept so its decisions can be read again. The line is the group's
 *   kicker and a quiet word ("Done 14 Sep"), a chevron hung in the gutter so the kicker keeps the
 *   column's line; the whole line is the button (`aria-expanded`), and it washes and rings as a lane
 *   does. Open, the group's lanes sit under it as any plain group's. It is never dressed and has no
 *   foot: finished is ordinary. The line is in the keyboard's run (↑ ↓, Home, End, type-ahead) and
 *   a closed group's lanes are not.
 * - **The chosen lane is never hidden without the line saying so.** A closed group holding the
 *   selected lane doesn't open itself (its open state is the caller's): its line takes the chosen
 *   look — the lit plate and the 2 px bar — its word becomes the chosen lane's name, and it is the
 *   tab stop. Opening it shows the lane, chosen.
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

/** A group that folds to one line, held open or closed by the caller (the URL, storage). */
type LaneGroupCollapse = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The quiet word at the line's end ("Done 14 Sep"), written capitalized. */
  summary: string;
};

/** A plain group, or one dressed apart while it waits on a person (with its foot). */
type StandingGroup = {
  /** The group's kicker ("Pipelines"). A group without one is the sidebar's lead lanes. */
  label?: string;
  lanes: readonly Lane[];
  /** Set apart from the plain groups (the seasonal pass while open). Plain without one. */
  dress?: LaneDress;
  /** Not navigation, but the group's own (its meter and that meter's line): under its lanes. */
  foot?: ReactNode;
  collapsible?: never;
};

/** A group that folds to its kicker's line: never dressed, no foot — finished is ordinary. */
type CollapsibleGroup = {
  /** The line's name, and its list's. */
  label: string;
  lanes: readonly Lane[];
  collapsible: LaneGroupCollapse;
  dress?: never;
  foot?: never;
};

type LaneGroup = StandingGroup | CollapsibleGroup;

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

/**
 * A collapsible group's line is the lane step tall, its text centered, so the line sits that much
 * higher than its text — `(size-lane − type-kick) / 2` — to land the text where a plain kicker's
 * would: `space-3_5` under the column's top when it leads, `space-3` under the group before
 * otherwise. Written out whole: Tailwind only sees classes it can read in the source.
 */
const FOLD_LEAD = 'pt-[calc(var(--space-3_5)-(var(--size-lane)-var(--type-kick))/2)]';
const FOLD_AFTER = 'mt-[calc(var(--space-3)-(var(--size-lane)-var(--type-kick))/2)]';

/** One stop in the keyboard's run: a lane, or a collapsible group's line. */
type Stop = { key: string; label: string };

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
  const lineKey = (g: number) => `${baseId}-line-${g}`;
  const closed = (group: LaneGroup) => group.collapsible !== undefined && !group.collapsible.open;
  // The keyboard's run, in reading order: each collapsible group's line, then its lanes while open.
  const all: Stop[] = groups.flatMap((group, g) => [
    ...(group.collapsible ? [{ key: lineKey(g), label: group.label }] : []),
    ...(closed(group) ? [] : group.lanes.map((l) => ({ key: l.id, label: l.label }))),
  ]);
  // The chosen lane, or the line of the closed group that holds it.
  const holder = groups.findIndex(
    (group) => closed(group) && group.lanes.some((l) => l.id === selected),
  );
  const selectedStop = holder === -1 ? selected : lineKey(holder);
  const lead = groups[0];
  const rows = useRef(new Map<string, HTMLElement>());
  const typed = useRef({ text: '', at: 0 });
  // The tab stop: the stop last focused, else the selected lane (or its line), else the first.
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const stop =
    [focused, selectedStop].find((key) => key !== undefined && all.some((s) => s.key === key)) ??
    all[0]?.key;
  const keep = (key: string) => (el: HTMLElement | null) => {
    if (el === null) rows.current.delete(key);
    else rows.current.set(key, el);
  };

  const focusLane = (id: string | undefined) => {
    if (id === undefined) return;
    rows.current.get(id)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const at = all.findIndex((s) => rows.current.get(s.key) === document.activeElement);
    if (at === -1) return;
    const move = (to: number) => {
      event.preventDefault();
      focusLane(all[Math.max(0, Math.min(all.length - 1, to))]?.key);
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
    const hit = order.find((s) => s.label.toLocaleLowerCase().startsWith(query));
    if (hit !== undefined) focusLane(hit.key);
  };

  const laneList = (group: LaneGroup, g: number, inset: string | undefined) => (
    <ul
      aria-labelledby={group.label !== undefined ? `${baseId}-${g}` : undefined}
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
            rowRef={keep(lane.id)}
            onFocus={() => setFocused(lane.id)}
            onClick={() => onSelect?.(lane.id)}
            inset={inset}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <nav
      aria-label={label}
      data-slot="lanes"
      className={cn(
        'flex h-full min-h-0 w-full flex-col pt-(--space-3_5)',
        lead?.collapsible !== undefined && FOLD_LEAD,
        lead?.dress !== undefined && LANE_DRESSES[lead.dress].lead,
        className,
      )}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <div data-slot="lanes-groups" className="flex min-h-0 flex-col gap-(--space-0_5)">
        {groups.map((group, g) => {
          const kickerId = `${baseId}-${g}`;
          if (group.collapsible !== undefined) {
            const { open, onOpenChange, summary } = group.collapsible;
            const held = g === holder ? group.lanes.find((l) => l.id === selected) : undefined;
            return (
              <Collapsible
                // biome-ignore lint/suspicious/noArrayIndexKey: a group's place is its identity.
                key={g}
                open={open}
                onOpenChange={(next) => onOpenChange(next)}
                data-slot="lanes-group"
                data-collapsible=""
                className={cn('gap-(--space-0_5)', g > 0 && FOLD_AFTER)}
              >
                <CollapsiblePrimitive.Trigger
                  ref={keep(lineKey(g))}
                  data-slot="lanes-line"
                  data-holds-selected={held !== undefined ? '' : undefined}
                  tabIndex={lineKey(g) === stop ? 0 : -1}
                  onFocus={() => setFocused(lineKey(g))}
                  className={cn(
                    'group/collapsible relative flex h-lane w-full min-w-0 cursor-pointer items-center gap-(--space-2) px-(--space-4_5) text-left outline-none select-none',
                    'border-0 bg-transparent text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase',
                    'transition-[background-color,color] duration-(--duration-fast) ease-standard',
                    // A lane's wash and ring: the line is pressable, as a lane is.
                    'lit:bg-lift-05 lit:text-fg1 focus-visible:inset-ring-1 focus-visible:inset-ring-fg',
                    held !== undefined &&
                      'bg-lift-08 text-fg shadow-select-rule lit:bg-lift-08 lit:text-fg',
                  )}
                >
                  {/* Hung in the gutter, so the kicker keeps the column's line. */}
                  <CollapsibleChevron className="absolute start-(--space-1)" />
                  {/* The word is never cut; short of room, the kicker gives way. Its tracking
                      trails the last letter: given back, so the gap is the gap. */}
                  <span id={kickerId} className="-me-(--track-kick) min-w-0 truncate">
                    {group.label}
                  </span>
                  <span
                    data-slot="lanes-line-summary"
                    className="ms-auto shrink-0 text-assist font-regular tracking-normal normal-case"
                  >
                    {held?.label ?? summary}
                  </span>
                </CollapsiblePrimitive.Trigger>
                <CollapsibleContent className="flex flex-col">
                  {laneList(group, g, undefined)}
                </CollapsibleContent>
              </Collapsible>
            );
          }
          const dress = group.dress === undefined ? undefined : LANE_DRESSES[group.dress];
          const groupProps = {
            'data-slot': 'lanes-group',
            'data-dress': group.dress,
            className: cn(
              'flex flex-col gap-(--space-0_5)',
              dress?.group,
              // A dressed group's box stands where a kicker would: as far under the group before.
              dress !== undefined && g > 0 && 'mt-(--space-3)',
            ),
            children: (
              <>
                {group.label !== undefined && (
                  <div
                    id={kickerId}
                    data-slot="lanes-kicker"
                    className={cn(
                      'px-(--space-4_5) pb-(--space-1_5) text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase',
                      g > 0 && dress === undefined && 'pt-(--space-3)',
                      dress?.kicker,
                    )}
                  >
                    {group.label}
                  </div>
                )}
                {laneList(group, g, dress?.row)}
                {group.foot != null && (
                  <div
                    data-slot="lanes-group-foot"
                    className={cn(
                      'flex flex-col gap-(--space-1_5) px-(--space-4_5) pt-(--space-2_5) text-assist leading-(--lead-list) text-fg2',
                      dress?.foot,
                    )}
                  >
                    {group.foot}
                  </div>
                )}
              </>
            ),
          };
          return (
            // Groups are positional: the sidebar's layout.
            // biome-ignore lint/suspicious/noArrayIndexKey: a group's place is its identity.
            <Fragment key={g}>
              {dress?.render ? dress.render(groupProps) : <div {...groupProps} />}
            </Fragment>
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
  /** A dressed group's inset, so the row's name and count keep the column's line. */
  inset: string | undefined;
};

function LaneRow({
  lane,
  on,
  tabbable,
  linked,
  render,
  rowRef,
  onFocus,
  onClick,
  inset,
}: LaneRowProps) {
  // A count whose ink means something (amber waits on a person, red failed) keeps it when its lane
  // is chosen — choosing the lane answers neither (board 8.1); only the quiet count lights.
  const tone =
    lane.countTone === 'warn' || lane.countTone === 'bad'
      ? lane.countTone
      : on
        ? 'lit'
        : (lane.countTone ?? 'default');
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
        inset,
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

export {
  type Lane,
  type LaneDress,
  type LaneGroup,
  type LaneGroupCollapse,
  Lanes,
  type LanesProps,
};
