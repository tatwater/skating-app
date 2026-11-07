import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';

import { cn } from '@/lib/utils';

/**
 * The kit's Separator: shadcn's Base UI separator, re-skinned to the boards' hairlines.
 *
 * - **One hair thick** (`stroke-hair`, px: a rule is drawing, not reading — D233), in `line`, the
 *   pane borders' gray. `strong` takes `line2`, the stronger rule: the status bar's vertical rule
 *   between its lamp, its keys and its runs is drawn in it (`.status .sep`).
 * - **Horizontal** runs the full width of its parent — a rule between blocks in a pane.
 * - **Vertical** stands `space-3` tall (the status bar's rule, a little shorter than its type
 *   line), centered by its row; pass a height (or `self-stretch`) for a full-height divider.
 * - **No margins.** The row or stack it sits in owns the gap on each side, so the rule never
 *   adds space a composition didn't ask for.
 * - It is a `separator` to a reader, with its orientation. A group of controls that needs a rule
 *   between its members (a toolbar) uses its own separator so roving focus knows to skip it.
 */
type SeparatorProps = SeparatorPrimitive.Props & {
  /** The stronger rule (`line2`): the status bar's vertical rule. */
  strong?: boolean;
};

function Separator({
  className,
  orientation = 'horizontal',
  strong = false,
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      data-strong={strong ? '' : undefined}
      orientation={orientation}
      className={cn(
        'm-0 shrink-0 border-0',
        strong ? 'bg-line2' : 'bg-line',
        orientation === 'horizontal'
          ? 'h-(--stroke-hair) w-full'
          : 'h-(--space-3) w-(--stroke-hair) self-center',
        className,
      )}
      {...props}
    />
  );
}

export { Separator, type SeparatorProps };
