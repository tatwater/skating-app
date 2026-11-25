import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { type CSSProperties, type ReactNode, useId } from 'react';

import { Badge } from '@/components/kit/badge';
import { RadioGroup } from '@/components/kit/radio';
import { cn } from '@/lib/utils';

/**
 * **The consequence ladder** — a kit candidate (B01-7a; board 4.3's *What each class would do*):
 * every value a person may choose, one row each, with what each source says of it and what
 * choosing it does.
 *
 * - **A row is a radio** (the circle at its start, the value, its Now and Suggested badges —
 *   Review 11 rule 3), then one cell per source (`columns`) holding that source's mark for this
 *   value (a square and its token, — where it said nothing), then the consequence in words.
 * - **The pick is a 1 px bright edge** round the whole row over a lifted ground (Review 9 rule 7),
 *   the row above it losing its rule so the edge reads alone. Picking moves the pick; the bar's
 *   button (or ⏎ in the pane) applies it.
 * - **No source columns** when none are given (the sources not recorded yet): the value, then what
 *   choosing it does.
 * - **A row whose consequence is a loss** (`emphasis`, 4.3's *Leaves the corpus*) says it in the
 *   bright ink. The words are the caller's; this never says anything about the ice (D3).
 * - **Table rules**: a hairline between rows, none under the last (Review 10 rule 2).
 * - **Narrow** (the ladder under {@link NARROW_LADDER}, an inspector at its least — 380 px at the
 *   narrowest page that keeps the columns): the consequence goes under its row's value and marks,
 *   across the row, and its head goes, so no column is squeezed to a word a line.
 *
 * Promoting it: as `ChoiceRows`, its circle is `kit/radio`'s `Dot`, redrawn here.
 */

export type LadderColumn = { key: string; label: ReactNode };

export type LadderRung<V extends string = string> = {
  value: V;
  /** The value's words (“Wetland”): its name for a reader too. */
  label: string;
  now?: boolean;
  suggested?: boolean;
  disabled?: boolean;
  /** Each source's mark for this value, by column key; absent: the source said nothing (—). */
  marks?: Partial<Record<string, string>>;
  /** What choosing it does. */
  consequence: ReactNode;
  /** The consequence is a loss (the body leaves): said in the bright ink. */
  emphasis?: boolean;
};

export type ConsequenceLadderProps<V extends string = string> = {
  rungs: readonly LadderRung<V>[];
  /** The sources, in their column order; none draws none. */
  columns?: readonly LadderColumn[];
  value: V | null;
  onValueChange?: (value: V) => void;
  readOnly?: boolean;
  /** The first column's head (“Class”) and the last's (“What choosing it does”). */
  valueHead: string;
  consequenceHead: string;
  nowLabel?: string;
  suggestedLabel?: string;
  'aria-label': string;
  className?: string;
};

/** The grid's columns, wide or narrow, from the custom properties the root sets. */
const COLUMNS = 'grid-cols-(--ladder-cols) @max-[36rem]:grid-cols-(--ladder-cols-narrow)';

const HEAD =
  'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase whitespace-nowrap truncate';

/** The value column, each source's, then the consequence: one template for the heads and every row. */
const template = (n: number) => `minmax(0,12.5rem) ${'minmax(0,6.25rem) '.repeat(n)}minmax(0,1fr)`;
/** Narrow: the value takes what the sources leave; the consequence runs under them, full width. */
const narrowTemplate = (n: number) => `minmax(0,1fr) ${'minmax(0,5.5rem) '.repeat(n)}`.trim();
// (Narrow, the value's words wrap beside the dot, never cut, and its badges go under them.)

/** The ladder's width below which a row's consequence goes under it (its container's query). */
export const NARROW_LADDER = '36rem';

export function ConsequenceLadder<V extends string = string>({
  rungs,
  columns = [],
  value,
  onValueChange,
  readOnly = false,
  valueHead,
  consequenceHead,
  nowLabel = 'Now',
  suggestedLabel = 'Suggested',
  className,
  ...props
}: ConsequenceLadderProps<V>) {
  const id = useId();
  const grid = {
    '--ladder-cols': template(columns.length),
    '--ladder-cols-narrow': narrowTemplate(columns.length),
    // Narrow, the consequence starts under the value's words: past the dot and its gap.
    '--ladder-indent': 'calc(var(--type-kick) + var(--space-2_5))',
    // …and the value's words take the rest of the first line, so its badges go under them.
    '--ladder-label': 'calc(100% - var(--type-kick) - var(--space-2_5))',
  } as CSSProperties;
  const picked = rungs.findIndex((r) => r.value === value);
  return (
    <div
      data-slot="consequence-ladder"
      className={cn('@container flex min-w-0 flex-col', className)}
    >
      <div
        data-slot="ladder-head"
        aria-hidden="true"
        className={cn(
          'grid items-center gap-x-(--space-3) border-0 border-b-(length:--stroke-hair) border-solid border-line2 px-(--space-2_5) pb-(--space-2_5)',
          COLUMNS,
        )}
        style={grid}
      >
        <span className={HEAD}>{valueHead}</span>
        {columns.map((c) => (
          <span key={c.key} className={HEAD}>
            {c.label}
          </span>
        ))}
        <span data-slot="ladder-consequence-head" className={cn(HEAD, '@max-[36rem]:hidden')}>
          {consequenceHead}
        </span>
      </div>
      <RadioGroup
        aria-label={props['aria-label']}
        value={value}
        readOnly={readOnly}
        onValueChange={(v) => onValueChange?.(v as V)}
        className="flex-col"
      >
        {rungs.map((r, i) => (
          <RadioPrimitive.Root
            key={r.value}
            value={r.value}
            disabled={r.disabled === true}
            aria-label={r.label}
            aria-describedby={`${id}-${i}`}
            data-slot="ladder-rung"
            data-now={r.now ? '' : undefined}
            data-suggested={r.suggested ? '' : undefined}
            // The row over the pick drops its rule, so the pick's edge reads alone.
            data-before-pick={i === picked - 1 ? '' : undefined}
            // The group appends a hidden input, so `:last-child` never finds the last rung.
            data-last={i === rungs.length - 1 ? '' : undefined}
            className={cn(
              'group/rung grid min-h-[2.75rem] items-center gap-x-(--space-3) px-(--space-2_5) py-(--space-1_5) text-start',
              COLUMNS,
              '@max-[36rem]:gap-y-(--space-1_5) @max-[36rem]:py-(--space-2_5)',
              'border-0 border-b-(length:--stroke-hair) border-solid border-line data-last:border-b-0 data-before-pick:border-b-transparent',
              'cursor-pointer rounded-container outline-none',
              'transition-[background-color,box-shadow] duration-(--duration-fast) ease-standard',
              '[--rim:var(--fg3)] lit:not-data-checked:[--rim:var(--fg2)] data-checked:[--rim:var(--fg)]',
              'lit:not-data-checked:bg-lift-03 data-checked:border-b-transparent data-checked:bg-lift-05 data-checked:inset-ring data-checked:inset-ring-fg',
              'focus-visible:shadow-focus',
              'data-disabled:cursor-default data-disabled:[--rim:var(--line2)] data-disabled:lit:bg-transparent',
              'data-readonly:cursor-default data-readonly:lit:bg-transparent',
            )}
            style={grid}
          >
            <span className="flex min-w-0 items-center gap-(--space-2_5) @max-[36rem]:flex-wrap @max-[36rem]:gap-y-(--space-1_5)">
              <span
                data-slot="rung-dot"
                className="relative inline-flex size-(--type-kick) shrink-0 rounded-full border border-solid border-(--rim) transition-[border-color] duration-(--duration-instant) ease-standard"
              >
                <RadioPrimitive.Indicator className="absolute inset-[2px] rounded-full bg-(--rim)" />
              </span>
              <span
                data-slot="rung-label"
                className="min-w-0 truncate text-body leading-none font-medium text-fg1 group-data-checked/rung:text-fg @max-[36rem]:basis-(--ladder-label) @max-[36rem]:overflow-visible @max-[36rem]:leading-snug @max-[36rem]:whitespace-normal"
              >
                {r.label}
              </span>
              {r.now && (
                <Badge
                  variant="outline"
                  tone="lit"
                  data-slot="rung-now"
                  className="@max-[36rem]:ms-(--ladder-indent)"
                >
                  {nowLabel}
                </Badge>
              )}
              {r.suggested && (
                <Badge
                  variant="outline"
                  data-slot="rung-suggested"
                  className="@max-[36rem]:ms-(--ladder-indent)"
                >
                  {suggestedLabel}
                </Badge>
              )}
            </span>
            {columns.map((c) => {
              const mark = r.marks?.[c.key];
              return mark === undefined ? (
                <span key={c.key} data-slot="rung-silent" className="text-row text-line2">
                  —
                </span>
              ) : (
                <span
                  key={c.key}
                  data-slot="rung-mark"
                  className="flex min-w-0 items-center gap-(--space-1_5) font-(family-name:--family-mono) text-kick leading-none text-fg2"
                >
                  <i aria-hidden="true" className="size-(--space-2) shrink-0 bg-fg" />
                  <span className="min-w-0 truncate">{mark}</span>
                </span>
              );
            })}
            <span
              id={`${id}-${i}`}
              data-slot="rung-consequence"
              data-emphasis={r.emphasis ? '' : undefined}
              className="min-w-0 text-row leading-snug text-fg2 data-emphasis:font-medium data-emphasis:text-fg group-data-checked/rung:text-fg1 group-data-checked/rung:data-emphasis:text-fg @max-[36rem]:col-span-full @max-[36rem]:ps-(--ladder-indent)"
            >
              {r.consequence}
            </span>
          </RadioPrimitive.Root>
        ))}
      </RadioGroup>
    </div>
  );
}
