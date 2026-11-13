import { Children, type ComponentProps, isValidElement, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { SkeletonStat, SkeletonText } from './skeleton';

/**
 * The kit's stat: the boards' `.stats12` cell — a kicker, a big mono value with its unit, a
 * sub-line — and the grid that rules them. **Not a card**: no box, no fill; a grid of cells divided
 * by dotted hairlines.
 *
 * - **Value, then unit, then sub-line.** The value is the stat step in mono (`fg`, or a tone by
 *   meaning); its unit sits in the small gray slot (light mono, `fg3`), **7 px from the value with
 *   no space character between them** — the gap is drawn, so it is the same 7 px everywhere. Ink to
 *   ink: the value's trailing tracking is given back, so the 7 px is from the last digit.
 * - **Tones by meaning only**: `warn` (amber, waits on a person), `bad` (red, won't recover without
 *   one), `dim` (a value that doesn't count yet). Never ice — a value is never water.
 * - **Loading takes the exact final box**: the value becomes a stat skeleton exactly as many mono
 *   characters wide as the value will be, the sub-line a skeleton of its trimmed line; the label is
 *   known, so it stays. Nothing moves when the numbers land.
 * - **The grid's rules never break** (R9): a cell's divider is padding, never margin, so each dotted
 *   row rule runs unbroken across the grid and each column rule down it. The first column has no
 *   left inset and the last no right inset, so the values line up with the section over them; the
 *   last row has no rule under it, and there is no rule over the first.
 */

type StatTone = 'default' | 'warn' | 'bad' | 'dim';

const VALUE_TONE: Record<StatTone, string> = {
  default: 'text-fg',
  warn: 'text-warn',
  bad: 'text-bad',
  dim: 'text-fg3',
};

/** The value's type: the stat step in mono, tracked, one line box tall. */
const VALUE_TYPE = 'font-(family-name:--family-mono) text-stat leading-none font-medium';

type ValueProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** The figure itself ("14", "$75.80", "177,400"). */
  value: ReactNode;
  /** Its unit or qualifier ("in 11 posts", "weighted", "MB") — set in the gray slot. */
  unit?: ReactNode;
  tone?: StatTone;
};

/**
 * A value with its unit: the digits, then the unit 7 px on, with no space character between them.
 * A visually hidden space keeps a screen reader from running the two words together.
 */
function Value({ value, unit, tone = 'default', className, ...props }: ValueProps) {
  return (
    <span
      data-slot="value"
      data-tone={tone}
      className={cn('block whitespace-nowrap', VALUE_TYPE, VALUE_TONE[tone], className)}
      {...props}
    >
      <span
        data-slot="value-figure"
        // The trailing tracking after the last digit is given back, so the unit's 7 px is ink to ink.
        className="tracking-value tabular-nums me-[calc(-1*var(--track-value))]"
      >
        {value}
      </span>
      {unit != null && (
        <>
          <span className="sr-only"> </span>
          <span
            data-slot="value-unit"
            // 7 px at the 16 px base (0.4375rem): the mocks' value–unit gap, in rem (D233).
            className="ms-[0.4375rem] text-row font-light tracking-normal text-fg3"
          >
            {unit}
          </span>
        </>
      )}
    </span>
  );
}

type StatTileProps = Omit<ComponentProps<'div'>, 'children'> &
  Pick<ValueProps, 'value' | 'unit' | 'tone'> & {
    /** What is counted ("Reports"), written capitalized; set as a kicker. */
    label: ReactNode;
    /** The sub-line under the value ("2 new · 4 returning"). Starts with a capital. */
    sub?: ReactNode;
    /** The numbers are on their way: the value and sub-line hold their exact boxes. */
    loading?: boolean;
    /**
     * How many characters the value will have, for the loading box (`$75.80` is 6). Defaults to
     * the length of a string or number `value`.
     */
    chars?: number;
  };

const KICK = 'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase';
/** The sub-line: assistive type, trimmed to its letterforms so the 4 px over it is ink to ink. */
const SUB = 'text-trim text-assist leading-list text-fg3';

/** A stat: the kicker, the value with its unit, the sub-line — `space-1` apart. */
function StatTile({
  label,
  value,
  unit,
  tone = 'default',
  sub,
  loading = false,
  chars,
  className,
  ...props
}: StatTileProps) {
  const width =
    chars ?? (typeof value === 'string' || typeof value === 'number' ? String(value).length : 4);
  return (
    <div
      data-slot="stat-tile"
      aria-busy={loading || undefined}
      className={cn('flex min-w-0 flex-col gap-(--space-1)', className)}
      {...props}
    >
      <span data-slot="stat-label" className={KICK}>
        {label}
      </span>
      {loading ? <SkeletonStat chars={width} /> : <Value value={value} unit={unit} tone={tone} />}
      {sub != null &&
        (loading ? (
          // A trimmed line is exactly one cap height tall: the skeleton paints that band only.
          <SkeletonText className={cn(SUB, 'h-[1cap] py-0')} width="70%" />
        ) : (
          <span data-slot="stat-sub" className={SUB}>
            {sub}
          </span>
        ))}
    </div>
  );
}

type StatGridProps = ComponentProps<'div'> & {
  /** Cells per row. Default 4 (the boards' 4 × 3). */
  columns?: number;
  /**
   * The dotted rules between cells. Default on; off is a bare strip (the Overview's season stats):
   * no rules, the cells `space-5` apart both ways, content to content.
   */
  ruled?: boolean;
};

/**
 * Stat tiles on a ruled grid. Each child is wrapped in a cell whose dividers are padding: dotted
 * row rules under every row but the last, dotted column rules after every column but the last.
 * Unruled, the cells carry no padding and the grid's own gap spaces them, so a value sits where
 * the column starts and the strip's edges are its content's.
 */
function StatGrid({
  columns = 4,
  ruled = true,
  className,
  style,
  children,
  ...props
}: StatGridProps) {
  const cells = Children.toArray(children).filter(isValidElement);
  const rows = Math.ceil(cells.length / columns);
  return (
    <div
      data-slot="stat-grid"
      data-ruled={ruled ? '' : undefined}
      className={cn('grid', !ruled && 'gap-(--space-5)', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, ...style }}
      {...props}
    >
      {cells.map((cell, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        return (
          <div
            key={String(cell.key)}
            data-slot="stat-cell"
            className={cn(
              'min-w-0',
              ruled && [
                'border-dotted border-line px-(--space-3) py-(--space-2_5)',
                col === 0 && 'ps-0',
                col === columns - 1 ? 'pe-0' : 'border-e-(length:--stroke-hair)',
                row < rows - 1 && 'border-b-(length:--stroke-hair)',
              ],
            )}
          >
            {cell}
          </div>
        );
      })}
    </div>
  );
}

export {
  StatGrid,
  type StatGridProps,
  StatTile,
  type StatTileProps,
  type StatTone,
  Value,
  type ValueProps,
};
