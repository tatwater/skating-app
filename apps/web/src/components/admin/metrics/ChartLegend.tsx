import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A chart's key, at the end of its section's rule: a swatch and a name per series, in mono caps
 * (the boards' `.lg2`). A bar's swatch is an 8 px square in its fill; a line's is a 16 px hairline
 * in its stroke. Local to Metrics — the kit's `MatrixLegend` is the temperature scale's, and stays
 * that.
 */

type LegendItem = {
  /** The series' name, written capitalized ("Hours waiting"); set in caps. */
  label: ReactNode;
  /** The series' paint, as a CSS color (a token: `var(--bad)`). */
  ink: string;
  /** `bar` (default) draws a square, `line` a hairline. */
  mark?: 'bar' | 'line';
};

type ChartLegendProps = Omit<ComponentProps<'ul'>, 'children'> & {
  items: readonly LegendItem[];
};

function ChartLegend({ items, className, ...props }: ChartLegendProps) {
  return (
    <ul
      data-slot="chart-legend"
      className={cn('m-0 flex list-none flex-wrap items-center gap-(--space-3_5) p-0', className)}
      {...props}
    >
      {items.map((item, i) => (
        <li
          // A legend's order is its series' order, and never changes under it.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, fixed
          key={i}
          data-slot="chart-legend-item"
          className={cn(
            'inline-flex items-center gap-(--space-1_5) whitespace-nowrap',
            'font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase',
          )}
        >
          <span
            aria-hidden="true"
            data-slot="chart-legend-swatch"
            data-mark={item.mark ?? 'bar'}
            className={cn(
              'inline-block shrink-0',
              item.mark === 'line'
                ? 'h-0 w-(--space-4) border-t-(length:--stroke-hair) border-solid'
                : 'size-(--space-2)',
            )}
            style={item.mark === 'line' ? { borderColor: item.ink } : { background: item.ink }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export { ChartLegend, type ChartLegendProps, type LegendItem };
