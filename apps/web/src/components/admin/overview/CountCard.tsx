import { type ComponentProps, cloneElement, type ReactElement, type ReactNode } from 'react';

import { buttonVariants } from '@/components/kit/button';
import { GridList, GridListRow } from '@/components/kit/grid-list';
import { Section } from '@/components/kit/section-slug';
import { SkeletonText } from '@/components/kit/skeleton';
import { cn } from '@/lib/utils';

import { type OverviewTarget, useLinkTo } from './overviewLinks';
import type { ValueTone } from './overviewModel';

/**
 * A Home count card: a section slug over a ruled three-column list — what is counted, a detail
 * (a date, a split, a link), and the count itself in mono at the right edge.
 *
 * - **Rows are the board's 22 px**: the kit's ruled grid list with its row padding drawn down to
 *   the card's density, so the rules stay unbroken across the column gaps and the last row has none.
 * - **A row is a link only if it goes somewhere** (`to`): then the whole row is the link and lights
 *   on hover or focus. A row with a link chip of its own is not also a link.
 * - **The value's ink is its meaning**: zero steps back to the faint ink, amber waits on a person,
 *   red is safety or failure.
 */

/** The section's note at the rule's end ("19 open", "Campaign 12 Oct"): mono caps, quiet. */
export function SectionNote({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="section-note"
      className={cn(
        'font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3 uppercase',
        className,
      )}
      {...props}
    />
  );
}

type CountCardProps = Omit<ComponentProps<'section'>, 'title'> & {
  title: string;
  /** At the rule's end; without it the rule ends in the square. */
  end?: ReactNode;
  /** The column template: label · detail · value. */
  columns?: string;
  /** Rows still on their way: this many rows hold their place. */
  loadingRows?: number;
};

export function CountCard({
  title,
  end,
  columns = 'minmax(0, 1fr) auto auto',
  loadingRows,
  children,
  className,
  ...props
}: CountCardProps) {
  return (
    <Section
      title={title}
      end={end}
      data-slot="count-card"
      aria-busy={loadingRows !== undefined || undefined}
      className={className}
      {...props}
    >
      <GridList columns={columns} className="gap-x-(--space-4)">
        {loadingRows !== undefined
          ? Array.from({ length: loadingRows }, (_, i) => (
              // Placeholders are positional and never reorder.
              // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
              <GridListRow key={i} aria-hidden="true" className={ROW}>
                <SkeletonText width="60%" />
                <span />
                <SkeletonText width="2ch" />
              </GridListRow>
            ))
          : children}
      </GridList>
    </Section>
  );
}

/** The card's row density: the kit's ruled row with the board's 2 px padding. */
const ROW = 'in-data-ruled:py-(--space-0_5) text-row leading-list text-fg1';

const VALUE_TONE: Record<ValueTone, string> = {
  default: 'text-fg',
  dim: 'text-fg3',
  warn: 'text-warn',
  bad: 'text-bad',
};

const VALUE =
  'font-(family-name:--family-mono) text-assist leading-none font-medium tracking-value tabular-nums';

type CountRowProps = Omit<ComponentProps<'li'>, 'children'> & {
  /** What is counted ("Safety"); a node when it carries a tooltip. */
  label: ReactNode;
  /** A mark before the label (Machinery's status square). */
  mark?: ReactNode;
  /** Between the label and the value: a mono detail ("until 15 Oct") or a link chip. */
  detail?: ReactNode;
  /** The count, or a word ("not run"). */
  value: ReactNode;
  tone?: ValueTone;
  /** The value column's own tone for the detail (a status word is toned; a date is not). */
  detailTone?: ValueTone;
  /** Where the row goes; the whole row is the link. */
  to?: OverviewTarget;
};

export function CountRow({
  label,
  mark,
  detail,
  value,
  tone = 'default',
  detailTone = 'dim',
  to,
  className,
  ...props
}: CountRowProps) {
  const linkTo = useLinkTo();
  const cells = (
    <>
      <span
        data-slot="count-label"
        className="flex min-w-0 items-center gap-(--space-2) truncate whitespace-nowrap"
      >
        {mark}
        {label}
      </span>
      <span
        data-slot="count-detail"
        className={cn(
          'justify-self-end whitespace-nowrap',
          typeof detail === 'string' && [VALUE, VALUE_TONE[detailTone]],
        )}
      >
        {detail}
      </span>
      <span
        data-slot="count-value"
        data-tone={tone}
        className={cn('justify-self-end whitespace-nowrap', VALUE, VALUE_TONE[tone])}
      >
        {value}
      </span>
    </>
  );
  if (to === undefined) {
    return (
      <GridListRow data-slot="count-row" className={cn(ROW, className)} {...props}>
        {cells}
      </GridListRow>
    );
  }
  return (
    <GridListRow
      data-slot="count-row"
      className={cn(ROW, 'in-data-ruled:py-0', className)}
      {...props}
    >
      {cloneElement(
        linkTo(to) as ReactElement<ComponentProps<'a'>>,
        {
          'data-slot': 'count-link',
          className: cn(
            'col-span-full grid grid-cols-subgrid items-baseline py-(--space-0_5) text-inherit no-underline',
            'outline-none transition-[background-color] duration-(--duration-fast) ease-standard',
            'lit:bg-lift-05 pressed:bg-lift-08',
            'focus-visible:outline-(length:--stroke-hair) focus-visible:-outline-offset-1 focus-visible:outline-fg focus-visible:outline-solid',
          ),
          children: cells,
        } as ComponentProps<'a'>,
      )}
    </GridListRow>
  );
}

/** The card's foot: a quiet line under the rows, with an optional link at the value's edge. */
export function CountFoot({
  children,
  action,
  className,
  ...props
}: Omit<ComponentProps<'li'>, 'children'> & { children: ReactNode; action?: ReactNode }) {
  return (
    <GridListRow
      data-slot="count-foot"
      className={cn(ROW, 'text-assist text-fg3', className)}
      {...props}
    >
      <span className="col-span-2 min-w-0 truncate">{children}</span>
      <span className="flex self-center justify-self-end">{action}</span>
    </GridListRow>
  );
}

/**
 * A link chip ("Inbox →"): the kit's link-button look worn by the router's own link, so it is a
 * link to a reader and to the browser (a new tab on a middle click), never a button that navigates.
 * In a row it is drawn to the boards' 18 px chip so it fits a 22 px row.
 */
export function RowLink({
  to,
  children,
  inRow = true,
}: {
  to: OverviewTarget;
  children: ReactNode;
  /** Sized to sit in a count row; `false` for a section's end. */
  inRow?: boolean;
}) {
  const linkTo = useLinkTo();
  return cloneElement(
    linkTo(to) as ReactElement<ComponentProps<'a'>>,
    {
      'data-slot': 'row-link',
      className: cn(
        // In a row, the kit's row chip (18 px, fits a 22 px row); at a section's end, the xs link.
        buttonVariants({ variant: 'link', size: inRow ? 'row' : 'xs' }),
        'no-underline',
        inRow && 'self-center',
      ),
      children: (
        <span data-slot="label" className="inline-flex items-center gap-[inherit]">
          {children}
          {/* The arrow sits 3 px tighter to the edge (the boards' arrow pad), as the kit's link. */}
          <span aria-hidden="true" className="-mr-[3px]">
            →
          </span>
        </span>
      ),
    } as ComponentProps<'a'>,
  );
}
