import { type ComponentProps, type ReactNode, useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Kit candidate — the lever row** (People's `.lever`): one thing that can be changed about a
 * record, read across one line — its key, its state, and what can be done about it.
 *
 * - **Three columns**: the key in the row step, medium, the bright ink; the state in the assist
 *   step, by meaning — `quiet` (the faint ink: nothing to say), `ok` (the body ink: allowed — the
 *   quiet state, never green), `warn` (amber: below the default, waits on a person), `bad` (red:
 *   restricted); then the action — a kit `Button`, or a joined `ButtonGroup` (Extend | Lift) —
 *   centered on the row. The key column is the boards' 112 px.
 * - **An optional second line** spans the row under the three (`detail`): the season's figures under
 *   *Bounties*, the kinds under *On the record*. Emphasis (`<b>`) takes the body ink.
 * - **Rows sit on dotted rules**, a table row tall at least; the last row has none (a list ends on
 *   its spacing). Rows are not interactive: no hover wash — the action is its own button.
 * - A row is a named group (its key), so its action reads in context ("Comments, Restore").
 */

type LeverTone = 'quiet' | 'ok' | 'warn' | 'bad';

const TONE: Record<LeverTone, string> = {
  quiet: 'text-fg3',
  ok: 'text-fg1',
  warn: 'text-warn',
  bad: 'text-bad',
};

type LeverRowProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** What the lever is ("Comments"), capitalized. */
  label: ReactNode;
  /** Its state now ("Restricted · since 2 Oct"). */
  status: ReactNode;
  /** The state's ink, by meaning. Default `quiet`. */
  tone?: LeverTone;
  /** The row's action: a kit `Button` (`size="sm"`), or a joined `ButtonGroup` of them. */
  action?: ReactNode;
  /** A second line across the row. */
  detail?: ReactNode;
};

function LeverRow({
  label,
  status,
  tone = 'quiet',
  action,
  detail,
  className,
  ...props
}: LeverRowProps) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of facts with one action, not form fields — a named group, never a fieldset.
    <div
      role="group"
      aria-labelledby={id}
      data-slot="lever-row"
      data-tone={tone}
      className={cn(
        // The key column is the boards' 112 px (7rem): no token holds it.
        'grid min-h-td grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-x-(--space-2_5)',
        'border-0 border-b-(length:--stroke-hair) border-dotted border-line last:border-b-0',
        detail != null && 'gap-y-(--space-1_5) py-(--space-2)',
        className,
      )}
      {...props}
    >
      <span
        id={id}
        data-slot="lever-key"
        className="min-w-0 truncate text-row leading-list font-medium text-fg"
      >
        {label}
      </span>
      <span
        data-slot="lever-status"
        className={cn('min-w-0 truncate text-assist leading-list', TONE[tone])}
      >
        {status}
      </span>
      <span data-slot="lever-action" className="flex items-center justify-self-end">
        {action}
      </span>
      {detail != null && (
        <span
          data-slot="lever-detail"
          className="col-span-full min-w-0 text-assist leading-list text-fg3 [&_b]:font-regular [&_b]:text-fg1"
        >
          {detail}
        </span>
      )}
    </div>
  );
}

/** Lever rows, one under another. */
function LeverList({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="lever-list" className={cn('flex min-w-0 flex-col', className)} {...props} />
  );
}

export { LeverList, LeverRow, type LeverRowProps, type LeverTone };
