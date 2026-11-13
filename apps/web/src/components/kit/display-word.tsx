import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The display word (custom; B01-3): the one word a page or a column stands under, in the boards'
 * `.disp` — semibold sans caps in the bright ink, widely tracked, one line, no margin.
 *
 * - **`page`** — the page's word (*Overview*, `.pagehead .disp`): the console's display size,
 *   tracked `label`.
 * - **`column`** — a column's head (*Keeping up*, Metrics' `.q .disp`): the wordmark step, tracked
 *   `head`.
 *
 * It is type only: the heading level is the caller's (`render={<h1 />}`), and so is anything
 * around it — a column head's rule, a page head's tabs.
 */
const displayWordVariants = cva(
  'm-0 font-(family-name:--family-sans) font-semibold whitespace-nowrap text-fg uppercase',
  {
    variants: {
      // `leading-none` follows each size: tailwind-merge drops a leading that comes before a font
      // size, so set first it vanished and the word stood half again its type's height.
      size: {
        page: 'text-disp-lg leading-none tracking-label',
        column: 'text-logo leading-none tracking-head',
      },
    },
    defaultVariants: { size: 'page' },
  },
);

type DisplayWordProps = useRender.ComponentProps<'span'> & VariantProps<typeof displayWordVariants>;

function DisplayWord({ size = 'page', className, render, ...props }: DisplayWordProps) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      { className: cn(displayWordVariants({ size }), className) },
      props as ComponentProps<'span'>,
    ),
    render,
    state: { slot: 'display-word', size },
  });
}

export { DisplayWord, type DisplayWordProps, displayWordVariants };
