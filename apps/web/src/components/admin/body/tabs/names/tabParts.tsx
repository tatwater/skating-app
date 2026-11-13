import type { ComponentProps } from 'react';

import { SkeletonText } from '@/components/kit/skeleton';
import { cn } from '@/lib/utils';

/**
 * What the four inspector tabs (Names, Places, Access, Water) share and the kit doesn't: the
 * column their sections stack in, the place a section holds while its read is on its way, and the
 * lit-item wash. One-off to the Body console's tabs — the frame builder may fold these into its
 * own pane, which is a move, not a rewrite.
 */

/**
 * The gap between an inspector's sections: the boards' 30 px `.blk` margin (body-v5.html). No
 * spacing token holds 30 px (`space-7` is 28, `space-8` is 32); named here so one token replaces it.
 */
export const BLOCK_GAP = 'gap-[1.875rem]';

/** A tab's column of sections, ending on its spacing (a block never ends on a rule). */
export function TabBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="tab-body"
      className={cn('flex min-w-0 flex-col', BLOCK_GAP, className)}
      {...props}
    />
  );
}

/**
 * A section on its way: its slug's width of placeholder, then `lines` rows, holding the place the
 * section will take so nothing shifts when the read lands.
 */
export function LoadingSection({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-heading">
      <SkeletonText width="6rem" className="text-kick" />
      <SkeletonText lines={lines} className="text-row leading-list" />
    </div>
  );
}

/**
 * The lit item's wash — the deep link's addressable highlight (`?lit=…`): a lifted band reaching
 * half into each gutter, so the row it names is the first thing read.
 */
export const LIT_ROW =
  'data-lit:relative data-lit:before:pointer-events-none data-lit:before:absolute data-lit:before:-inset-x-(--space-2_5) data-lit:before:inset-y-0 data-lit:before:bg-lift-08 data-lit:before:content-[""]';

/** `data-lit` when `id` is the lit item. */
export const litAttr = (lit: string | null | undefined, id: string) =>
  lit === id ? { 'data-lit': '' } : {};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "29 Sep 2026", in the viewer's zone: a status date in a panel carries its year (Review 13 #7). */
export function dayMonthYear(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "12 Sep": a table cell or history row keeps day and month. */
export function dayMonth(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
