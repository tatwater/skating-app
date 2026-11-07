import { Combobox } from '@base-ui/react/combobox';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faXmark } from '@fortawesome/sharp-regular-svg-icons';
import { type ReactNode, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';

/**
 * The kit's chip input: Base UI's Combobox in `multiple` mode with its own chip parts (`Chips`,
 * `Chip`, `ChipRemove`) — the boards' `.chipin`, for aliases and other spellings, where most of
 * what's typed is new.
 *
 * - **The underline register**: chips and the field share one rule, which brightens and doubles on
 *   focus like the standard input. One row of chips stands exactly the surface's button height.
 * - **Chips are square, in the badge's register** — `size-badge` tall on the `raise` ground, the
 *   words in their own case (a name, not a state) — each with a remove ×.
 * - **Free text is created from a visible row, never silently.** While what's typed isn't already
 *   a chip or a suggestion, the list's first row reads "Add “…”"; ⏎ takes the selected row, so
 *   ⏎ adds the text only by way of that row. A duplicate says so instead.
 * - **Keys.** ⏎ adds the selected row; ⌫ in an empty field takes off the last chip; ← walks into
 *   the chips (⌫ there removes the one focused). The ⏎ cap shows only on the selected row.
 * - **Suggestions are the caller's**, fed by prop as the query changes (a server search); nothing
 *   is filtered here.
 * - Transitions ride the motion tokens, so reduced motion makes them instant.
 */

/** `{ value, label }`: the shape Base UI reads a label and a form value from by itself. */
type Option = { value: string; label: string; create?: true };

type ChipInputProps = {
  /** The chips. Controlled with `onValueChange`, or `defaultValue` to start from. */
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (value: string[]) => void;
  /** What the caller suggests for the current query (already narrowed by it). */
  suggestions?: readonly string[];
  /** The text being typed, for the caller's search. */
  onQueryChange?: (query: string) => void;
  /** A search is in flight. */
  loading?: boolean;
  placeholder?: string;
  /** The create row's words for a query. */
  createLabel?: (text: string) => ReactNode;
  disabled?: boolean;
  /** The field's name for a reader, when no kit `FieldLabel` names it. */
  'aria-label'?: string;
  /** For a form: one hidden input per chip under this name. */
  name?: string;
  className?: string;
};

const same = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** The list's row: a table row tall, the lift under the pointer or the arrows. */
const ROW = [
  'flex h-td cursor-pointer items-center gap-(--space-2) px-[1.15em]',
  'text-assist leading-none text-fg1 outline-none select-none',
  'transition-[background-color,color] duration-(--duration-instant) ease-standard',
  'data-highlighted:bg-lift-08 data-highlighted:text-fg',
];

function ChipInput({
  value: valueProp,
  defaultValue = [],
  onValueChange,
  suggestions = [],
  onQueryChange,
  loading = false,
  placeholder = 'Add a name skaters use',
  createLabel = (text) => `Add “${text}”`,
  disabled = false,
  'aria-label': ariaLabel,
  name,
  className,
}: ChipInputProps) {
  const [valueState, setValueState] = useState<readonly string[]>(defaultValue);
  const value = valueProp ?? valueState;
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLDivElement>(null);

  const selected = useMemo<Option[]>(() => value.map((v) => ({ value: v, label: v })), [value]);
  const text = query.trim();
  const duplicate = text !== '' && value.some((v) => same(v, text));
  const options = useMemo<Option[]>(() => {
    const offered = suggestions
      .filter((s) => !value.some((v) => same(v, s)))
      .map((s) => ({ value: s, label: s }));
    const known = duplicate || offered.some((o) => same(o.value, text));
    // The create row leads: most of what's typed here is new, and ⏎ takes the first row.
    return text === '' || known
      ? offered
      : [{ value: text, label: text, create: true }, ...offered];
  }, [suggestions, value, text, duplicate]);

  const setQueryBoth = (next: string) => {
    setQuery(next);
    onQueryChange?.(next);
  };

  const commit = (next: Option[]) => {
    const out: string[] = [];
    for (const o of next) {
      const v = o.value.trim();
      if (v !== '' && !out.some((x) => same(x, v))) out.push(v);
    }
    if (valueProp === undefined) setValueState(out);
    onValueChange?.(out);
    // Any change takes the typed text (Base UI clears its field on a chip change too).
    setQueryBoth('');
  };

  let note: ReactNode = null;
  if (duplicate) note = 'Already added';
  else if (loading) note = 'Searching';
  else if (text === '') note = 'Type a name to add it';

  return (
    <Combobox.Root
      multiple
      items={options}
      value={selected}
      onValueChange={(next: Option[]) => commit(next)}
      inputValue={query}
      onInputValueChange={(next) => setQueryBoth(next)}
      filter={null}
      autoHighlight
      isItemEqualToValue={(a: Option, b: Option) => same(a.value, b.value)}
      disabled={disabled}
      name={name}
    >
      <Combobox.Chips
        ref={anchor}
        data-slot="chip-input"
        className={cn(
          'flex min-h-btn w-full min-w-0 flex-wrap items-center gap-(--space-1_5)',
          // One row of chips is the button height, the rule's hairline included.
          'pt-[calc((var(--size-btn)-var(--size-badge))/2)]',
          'pb-[calc((var(--size-btn)-var(--size-badge))/2-var(--stroke-hair))]',
          'border-0 border-b border-solid border-line2 rounded-none',
          'transition-[border-color,box-shadow] duration-(--duration-fast) ease-standard',
          // Hover lifts a resting rule only: never over focus or a disabled field.
          '[@media(hover:hover)]:hover:not-focus-within:not-has-data-disabled:border-fg3',
          'focus-within:border-fg focus-within:shadow-[0_1px_0_0_var(--fg)]',
          'has-data-disabled:border-line',
          className,
        )}
      >
        <Combobox.Value>
          {(chips: Option[]) => (
            <>
              {chips.map((chip) => (
                <Combobox.Chip
                  key={chip.value}
                  data-slot="chip"
                  aria-label={chip.label}
                  className={cn(
                    'inline-flex h-badge max-w-full items-center gap-[0.3em] rounded-container bg-raise pr-[0.2em] pl-[0.6em]',
                    'text-assist leading-none text-fg1 outline-none',
                    'transition-[box-shadow,color] duration-(--duration-fast) ease-standard',
                    'focus:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)] focus:text-fg',
                    'data-disabled:text-fg-disabled',
                  )}
                >
                  <span className="truncate">{chip.label}</span>
                  <Combobox.ChipRemove
                    data-slot="chip-remove"
                    aria-label={`Remove ${chip.label}`}
                    className={cn(
                      'hit inline-flex size-[1.25em] shrink-0 cursor-pointer items-center justify-center text-fg3',
                      'transition-colors duration-(--duration-fast) ease-standard',
                      '[@media(hover:hover)]:hover:text-fg data-disabled:cursor-default data-disabled:text-fg-disabled',
                    )}
                  >
                    <FontAwesomeIcon icon={faXmark} aria-hidden="true" className="h-[0.9em]" />
                  </Combobox.ChipRemove>
                </Combobox.Chip>
              ))}
              <Combobox.Input
                data-slot="chip-input-field"
                aria-label={ariaLabel}
                placeholder={chips.length === 0 ? placeholder : undefined}
                className={cn(
                  'h-badge min-w-[5em] flex-1 bg-transparent p-0 outline-none',
                  'text-body leading-none font-regular text-fg placeholder:text-fg3',
                  'data-disabled:text-fg-disabled',
                )}
              />
            </>
          )}
        </Combobox.Value>
      </Combobox.Chips>

      <Combobox.Portal>
        <Combobox.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="isolate z-[calc(var(--z-viewer)+1)] outline-none"
        >
          <Combobox.Popup
            data-slot="chip-input-list"
            className={cn(
              'max-h-[min(var(--available-height),18rem)] w-(--anchor-width) overflow-y-auto py-(--space-1)',
              'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate outline-none',
              'font-(family-name:--family-sans)',
              'transition-opacity duration-(--duration-fast) ease-standard',
              'data-starting-style:opacity-0 data-ending-style:opacity-0',
            )}
          >
            <Combobox.Empty>
              {note != null && (
                <div data-slot="chip-input-note" className={cn(ROW, 'cursor-default text-fg3')}>
                  {note}
                </div>
              )}
            </Combobox.Empty>
            <Combobox.List>
              {(option: Option) => (
                <Combobox.Item
                  key={`${option.create ? '+' : ''}${option.value}`}
                  value={option}
                  data-slot={option.create ? 'chip-input-create' : 'chip-input-option'}
                  className={cn(ROW)}
                >
                  {option.create && (
                    <FontAwesomeIcon
                      icon={faPlus}
                      aria-hidden="true"
                      className="h-[0.9em] shrink-0 text-fg3 in-data-highlighted:text-fg"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {option.create ? createLabel(option.value) : option.label}
                  </span>
                  <Kbd
                    variant="dim"
                    aria-hidden="true"
                    className="invisible in-data-highlighted:visible"
                  >
                    ⏎
                  </Kbd>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export { ChipInput, type ChipInputProps };
