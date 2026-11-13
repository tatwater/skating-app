import { Autocomplete } from '@base-ui/react/autocomplete';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass, faSpinnerThird } from '@fortawesome/sharp-regular-svg-icons';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog';
import { Kbd } from './kbd';
import { ScrollArea } from './scroll-area';
import { FootKey, SearchGroupLabel, SearchStatus } from './search-parts';

/**
 * The kit's command palette (⌘K): Base UI's Autocomplete inside the kit Dialog — not shadcn's
 * Command, whose cmdk brings Radix in and filters on the client. Here the list is whatever the
 * caller hands over (`groups`, fed from a server search as `query` changes); nothing is filtered
 * in the browser.
 *
 * - **The ice edge.** The palette is a transient mode, the one place ice marks a surface: an ice
 *   hairline, its wash ring and glow, the search glyph and caret in ice.
 * - **Always open.** The list sits under the input from the first frame — no popup to open.
 * - **Groups take a kicker** with an optional count and a hairline run to the edge.
 * - **Keys only on the selected row**: its ⏎ (and ⇥ when it has actions); every other row's key
 *   slot is empty. The foot lists the palette's keys once.
 * - **⇥ moves to the selected row's actions**, ⇥ again to the next, ⇧⇥ back; ⏎ runs the one
 *   lit. ↑↓ return to the rows.
 * - **Empty and loading reserve the size**: the list region is one fixed height, so the palette
 *   never jumps as results come and go. Loading over earlier results keeps them, with a spinner
 *   in the input row; loading with nothing yet shows the spinner where the rows will be.
 * - **⌘K (or Ctrl K) anywhere** toggles it, even from inside a text field (`hotkey`).
 * - It fades on the motion tokens (the kit Dialog), so reduced motion makes it instant.
 */

/** Something the selected row can do besides open (⇥ reaches it). */
type CommandAction = {
  id: string;
  label: string;
};

/** A row: a body, a person, a run, a mode, an action. */
type CommandItem = {
  id: string;
  /** The name, in the row's bright ink. */
  label: string;
  /** What it is, quieter, after the name ("Reservoir · Enfield, NH"). */
  sub?: ReactNode;
  /** A short mono value at the row's end ("3 asks"); `metaTone` warns in amber. */
  meta?: ReactNode;
  metaTone?: 'default' | 'warn';
  /** A glyph in the leading slot. */
  icon?: ReactNode;
  /** What ⏎ does, beside its key on the selected row. */
  verb?: string;
  actions?: readonly CommandAction[];
};

type CommandGroup = {
  id: string;
  /** The kicker. Written capitalized; set in caps. */
  label: string;
  /** How many there are in all, when the group shows only some. */
  count?: number;
  items: readonly CommandItem[];
};

type CommandPaletteProps = {
  /** Controlled open state; leave both unset to let the trigger and ⌘K drive it. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details: { reason: string; event?: Event }) => void;
  /** The control that opens it (a kit Button). It wears ⌘K. */
  trigger?: ReactElement;
  /** Listen for ⌘K / Ctrl K anywhere on the page. Only one palette on a page should. */
  hotkey?: boolean;
  /** What's typed. The caller searches with it and hands back `groups`. */
  query: string;
  onQueryChange: (query: string) => void;
  groups: readonly CommandGroup[];
  /** A search is in flight. */
  loading?: boolean;
  /** A row (or one of its actions) was chosen. The palette closes after, unless `keepOpen`. */
  onSelect: (item: CommandItem, action?: CommandAction) => void;
  keepOpen?: boolean;
  placeholder?: string;
  /** What an empty result says. */
  empty?: ReactNode;
  /** The palette's name, for a reader (the title is not drawn). */
  title?: string;
  /** Scope it to a container (and pass `modal={false}`), as the kit Dialog does. */
  container?: HTMLElement | null;
  modal?: boolean;
  className?: string;
};

/** A row's box: icon, words, meta, keys. The selected row carries the inset bar and a lift. */
const ROW = [
  'grid h-td cursor-pointer grid-cols-[1.25em_minmax(0,1fr)_auto_auto] items-center gap-(--space-3) px-gutter',
  'text-row leading-none text-fg2 outline-none select-none',
  'transition-[background-color,color,box-shadow] duration-(--duration-instant) ease-standard',
  'data-highlighted:bg-lift-08 data-highlighted:text-fg data-highlighted:shadow-[inset_var(--stroke-note)_0_0_0_var(--fg)]',
];

function CommandPalette({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  trigger,
  hotkey = true,
  query,
  onQueryChange,
  groups,
  loading = false,
  onSelect,
  keepOpen = false,
  placeholder = 'Find a body, a person, a run, or an action',
  empty = 'Nothing matches',
  title = 'Command palette',
  container,
  modal,
  className,
}: CommandPaletteProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (next: boolean, details: { reason: string; event?: Event }) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next, details);
    },
    [openProp, onOpenChange],
  );

  // ⌘K / Ctrl K anywhere toggles it — inside a text field too.
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      setOpen(!open, { reason: 'hotkey', event });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey, open, setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={modal}>
      {trigger != null && <DialogTrigger render={trigger} aria-keyshortcuts="Meta+K Control+K" />}
      <DialogContent
        container={container}
        data-slot="command-palette"
        className={cn(
          // The ice edge: a transient mode.
          'border-acc shadow-[0_0_0_var(--stroke-run)_var(--acc-wash),0_0_var(--space-10)_0_var(--acc-glow)]',
          // High in the frame, so the list grows down from where the eye already is; one height.
          'top-[min(var(--space-20),12%)] translate-y-0',
          'w-[42.5rem] h-[min(28rem,calc(100%-min(var(--space-20),12%)-var(--gap-gutter)))]',
          className,
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <PaletteBody
          query={query}
          onQueryChange={onQueryChange}
          groups={groups}
          loading={loading}
          placeholder={placeholder}
          empty={empty}
          onSelect={(item, action) => {
            onSelect(item, action);
            if (!keepOpen) setOpen(false, { reason: 'item-press' });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

type PaletteBodyProps = Pick<
  CommandPaletteProps,
  'query' | 'onQueryChange' | 'groups' | 'loading' | 'onSelect'
> & { placeholder: string; empty: ReactNode };

/** The input, the list and the foot. The popup unmounts when closed, so each opening starts fresh. */
function PaletteBody({
  query,
  onQueryChange,
  groups,
  loading = false,
  onSelect,
  placeholder,
  empty,
}: PaletteBodyProps) {
  const [highlighted, setHighlighted] = useState<CommandItem | undefined>(undefined);
  // Which of the selected row's actions ⇥ has lit; `null` while the row itself is the target.
  const [actionIndex, setActionIndex] = useState<number | null>(null);
  const actions = highlighted?.actions ?? [];
  const lit = actionIndex === null ? undefined : actions[actionIndex];
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  const onKeyDown = (
    event: KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void },
  ) => {
    if (event.key === 'Tab') {
      // The palette is one field: ⇥ never leaves it; it walks the selected row's actions.
      event.preventDefault();
      if (highlighted === undefined || actions.length === 0) return;
      if (event.shiftKey) setActionIndex((i) => (i === null || i === 0 ? null : i - 1));
      else setActionIndex((i) => (i === null ? 0 : Math.min(i + 1, actions.length - 1)));
      return;
    }
    if (event.key === 'Enter' && highlighted !== undefined && lit !== undefined) {
      event.preventBaseUIHandler?.();
      event.preventDefault();
      onSelect(highlighted, lit);
    }
  };

  return (
    <Autocomplete.Root
      inline
      open
      mode="none"
      items={groups}
      value={query}
      onValueChange={(next, details) => {
        // Choosing a row would write its name into the field; the query stays what was typed.
        if (details.reason !== 'item-press') onQueryChange(next);
      }}
      itemToStringValue={(item: CommandItem) => item.label}
      autoHighlight="always"
      keepHighlight
      onItemHighlighted={(item: CommandItem | undefined) => {
        setHighlighted(item);
        setActionIndex(null);
      }}
    >
      <div
        data-slot="command-palette-input"
        className="flex shrink-0 items-center gap-(--space-3) border-b border-solid border-line px-gutter py-(--space-3_5)"
      >
        <FontAwesomeIcon
          icon={faMagnifyingGlass}
          aria-hidden="true"
          className="h-(--type-body) shrink-0 text-acc"
        />
        <Autocomplete.Input
          data-slot="command-palette-field"
          aria-label="Search"
          placeholder={placeholder}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent p-0 text-body leading-none font-regular text-fg caret-acc outline-none placeholder:text-fg3"
        />
        <span
          data-slot="command-palette-busy"
          aria-hidden="true"
          className={cn('shrink-0 text-row text-fg3', !(loading && count > 0) && 'invisible')}
        >
          <FontAwesomeIcon icon={faSpinnerThird} className="h-[1em] motion-safe:animate-spin" />
        </span>
      </div>

      <div data-slot="command-palette-region" className="relative min-h-0 flex-1">
        <ScrollArea className="size-full" viewportClassName="pb-(--space-2)">
          <Autocomplete.List data-slot="command-palette-list" className="outline-none">
            {(group: CommandGroup) => (
              <Autocomplete.Group
                key={group.id}
                items={group.items}
                data-slot="command-palette-group"
              >
                <SearchGroupLabel
                  data-slot="command-palette-group-label"
                  look="palette"
                  rule
                  {...(group.count !== undefined ? { count: group.count } : {})}
                >
                  {group.label}
                </SearchGroupLabel>
                <Autocomplete.Collection>
                  {(item: CommandItem) => (
                    <Row
                      key={item.id}
                      item={item}
                      selected={highlighted?.id === item.id}
                      actionIndex={highlighted?.id === item.id ? actionIndex : null}
                      onSelect={onSelect}
                    />
                  )}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>
        </ScrollArea>
        {count === 0 && (
          <SearchStatus
            data-slot="command-palette-note"
            loading={loading}
            className="absolute inset-0 text-row"
          >
            {empty}
          </SearchStatus>
        )}
      </div>

      <span className="sr-only" aria-live="polite">
        {lit !== undefined ? `${lit.label}, press Enter` : ''}
      </span>

      <div
        data-slot="command-palette-foot"
        className="flex shrink-0 items-center gap-(--space-4) border-t border-solid border-line px-gutter py-(--space-2_5) text-assist leading-none text-fg3"
      >
        <FootKey keys={['↑↓']}>move</FootKey>
        <FootKey keys={['⏎']}>open</FootKey>
        <FootKey keys={['⇥']}>actions</FootKey>
        <FootKey keys={['Esc']}>close</FootKey>
      </div>
    </Autocomplete.Root>
  );
}

type RowProps = {
  item: CommandItem;
  /** The highlighted row: it alone shows keys and actions. */
  selected: boolean;
  actionIndex: number | null;
  onSelect: (item: CommandItem, action?: CommandAction) => void;
};

function Row({ item, selected, actionIndex, onSelect }: RowProps) {
  const actions = item.actions ?? [];
  return (
    <Autocomplete.Item
      value={item}
      data-slot="command-palette-item"
      onClick={() => onSelect(item)}
      className={cn(ROW)}
    >
      <span
        data-slot="command-palette-icon"
        aria-hidden="true"
        className="inline-flex justify-center text-fg3 in-data-highlighted:text-fg [&_svg]:h-[1em]"
      >
        {item.icon}
      </span>
      <span className="min-w-0 truncate">
        <span
          data-slot="command-palette-label"
          className="font-medium text-fg1 in-data-highlighted:text-fg"
        >
          {item.label}
        </span>
        {item.sub != null && (
          <span data-slot="command-palette-sub" className="ml-(--space-2) text-assist text-fg3">
            {item.sub}
          </span>
        )}
      </span>
      <span
        data-slot="command-palette-meta"
        className={cn(
          'font-(family-name:--family-mono) text-mono-sm whitespace-nowrap',
          item.metaTone === 'warn' ? 'text-warn' : 'text-fg3',
        )}
      >
        {item.meta}
      </span>
      <span
        data-slot="command-palette-keys"
        aria-hidden="true"
        className="flex items-center gap-(--space-3) text-assist text-fg3"
      >
        {selected && actionIndex === null && (
          <>
            <KeyHint k="⏎">{item.verb ?? 'open'}</KeyHint>
            {actions.length > 0 && <KeyHint k="⇥">actions</KeyHint>}
          </>
        )}
        {selected &&
          actionIndex !== null &&
          actions.map((action, i) => (
            // ⇥ and ⏎ are the keyboard's way to an action; the press is the pointer's.
            // biome-ignore lint/a11y/noStaticElementInteractions: a reader hears the lit action announced
            // biome-ignore lint/a11y/useKeyWithClickEvents: ⇥ then ⏎ is this chip's key path
            <span
              key={action.id}
              data-slot="command-palette-action"
              data-lit={i === actionIndex ? '' : undefined}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item, action);
              }}
              className={cn(
                'inline-flex h-btn-xs items-center gap-(--space-1_5) px-[0.7em] whitespace-nowrap',
                'rounded-control inset-ring inset-ring-line2 text-fg2',
                'data-lit:bg-raise data-lit:text-fg data-lit:inset-ring-fg3',
              )}
            >
              {action.label}
              {i === actionIndex && <Kbd variant="dim">⏎</Kbd>}
            </span>
          ))}
      </span>
    </Autocomplete.Item>
  );
}

function KeyHint({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span data-slot="command-palette-key" className="inline-flex items-center gap-(--space-1_5)">
      <Kbd variant="dim">{k}</Kbd>
      {children}
    </span>
  );
}

export {
  type CommandAction,
  type CommandGroup,
  type CommandItem,
  CommandPalette,
  type CommandPaletteProps,
};
