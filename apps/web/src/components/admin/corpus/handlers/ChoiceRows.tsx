import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import type { ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { RadioGroup } from '@/components/kit/radio';
import { cn } from '@/lib/utils';

/**
 * **Choice rows** — a kit candidate (B01-6a; boards 4.2–4.6): a Corpus choice between a few
 * values, each a card with a radio, every one wearing what it is (Review 11 rule 3).
 *
 * - **Now and Suggested.** The current value wears the lit outlined badge (`nowLabel`, *Now* unless
 *   the board says *Shown now*); the value the queue suggests wears the gray outlined *Suggested*.
 *   The default pick is the caller's (the suggestion, else Now) — this only draws it.
 * - **The pick is a 1 px bright edge** around the card (Review 9 rule 7: a chosen card is a 1 px
 *   border, never a thick top edge), the radio filled, the label in the bright ink.
 * - **Picking moves the pick; it never applies it.** The bar's button (or ⏎ in the pane) applies
 *   it, and names it. Arrow keys move the pick within the group, as any radio group's.
 * - **A choice that can't be applied is disabled** (its verb refused): drawn, read only. A
 *   read-only group (a decided task) shows the values and marks, and takes no pick.
 * - **The card's evidence** (`children`) sits under the label: a fact list, a strip; room for a
 *   later line, so a card's height is its content's and the row's cards share the tallest.
 *
 * Promoting it: the radio's circle is `kit/radio`'s `Dot`, redrawn here because the kit doesn't
 * export it; a promotion exports it and this uses it.
 */

export type Choice<V extends string = string> = {
  value: V;
  /** The choice, set large (“Lake Auburn”). */
  label: ReactNode;
  /** Its name for a reader (the radio's accessible name; the label's text where it is one). */
  name: string;
  /** The value in use: wears Now. */
  now?: boolean;
  /** The value the queue suggests: wears Suggested. */
  suggested?: boolean;
  /** It can't be applied: drawn, not pickable. */
  disabled?: boolean;
  /** At the head's end: what vouches for it (its catalogs). */
  aside?: ReactNode;
  /** Its evidence, under the label. */
  children?: ReactNode;
};

export type ChoiceRowsProps<V extends string = string> = {
  choices: readonly Choice<V>[];
  /** The pick; `null` for none. */
  value: V | null;
  onValueChange?: (value: V) => void;
  /** Nothing to apply a pick with (a decided task): shown, never picked. */
  readOnly?: boolean;
  /** Cards side by side (4.2's two names), or one under another. */
  columns?: 1 | 2;
  /** The Now badge's words: *Now*, or the board's *Shown now*. */
  nowLabel?: string;
  suggestedLabel?: string;
  'aria-label': string;
  className?: string;
};

const DOT = cn(
  'relative inline-flex size-(--type-kick) shrink-0 rounded-full border border-solid border-(--rim)',
  'transition-[border-color] duration-(--duration-instant) ease-standard',
);

export function ChoiceRows<V extends string = string>({
  choices,
  value,
  onValueChange,
  readOnly = false,
  columns = 2,
  nowLabel = 'Now',
  suggestedLabel = 'Suggested',
  className,
  ...props
}: ChoiceRowsProps<V>) {
  return (
    <RadioGroup
      data-slot="choice-rows"
      aria-label={props['aria-label']}
      value={value}
      readOnly={readOnly}
      onValueChange={(v) => onValueChange?.(v as V)}
      className={cn(
        'grid gap-(--space-4)',
        columns === 2 ? 'grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))]' : 'grid-cols-1',
        className,
      )}
    >
      {choices.map((c) => (
        <RadioPrimitive.Root
          key={c.value}
          value={c.value}
          disabled={c.disabled === true}
          aria-label={c.name}
          data-slot="choice"
          data-now={c.now ? '' : undefined}
          data-suggested={c.suggested ? '' : undefined}
          className={cn(
            'group/choice flex min-w-0 flex-col items-stretch gap-(--space-3) text-start',
            'px-(--space-4) pt-(--space-3_5) pb-(--space-4)',
            'cursor-pointer rounded-container inset-ring inset-ring-line outline-none',
            'transition-[background-color,box-shadow] duration-(--duration-fast) ease-standard',
            '[--rim:var(--fg3)] lit:not-data-checked:[--rim:var(--fg2)] data-checked:[--rim:var(--fg)]',
            'lit:not-data-checked:bg-lift-03 data-checked:inset-ring-fg focus-visible:shadow-focus',
            'data-disabled:cursor-default data-disabled:[--rim:var(--line2)] data-disabled:lit:bg-transparent',
            'data-readonly:cursor-default data-readonly:lit:bg-transparent',
          )}
        >
          <span
            data-slot="choice-head"
            className="flex min-h-(--size-pill) min-w-0 items-center gap-(--space-2_5)"
          >
            <span data-slot="choice-dot" className={DOT}>
              <RadioPrimitive.Indicator className="absolute inset-[2px] rounded-full bg-(--rim)" />
            </span>
            {c.now && (
              <Badge variant="outline" tone="lit" data-slot="choice-now">
                {nowLabel}
              </Badge>
            )}
            {c.suggested && (
              <Badge variant="outline" data-slot="choice-suggested">
                {suggestedLabel}
              </Badge>
            )}
            {c.aside != null && (
              <span data-slot="choice-aside" className="ms-auto flex min-w-0 shrink-0 items-center">
                {c.aside}
              </span>
            )}
          </span>
          <span
            data-slot="choice-label"
            className={cn(
              'block min-w-0 truncate text-[calc(var(--type-disp)*1.25)] leading-[1.1] font-medium text-fg1',
              'group-data-checked/choice:text-fg',
            )}
          >
            {c.label}
          </span>
          {c.children != null && (
            <span data-slot="choice-body" className="flex min-w-0 flex-col gap-(--space-3)">
              {c.children}
            </span>
          )}
        </RadioPrimitive.Root>
      ))}
    </RadioGroup>
  );
}
