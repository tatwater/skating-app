import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * **The fact list** — the boards' `.kv` (2.1's *Author* and *Also on this report*,
 * 2.6's *The alert* and *What each does*): a short run of facts down a kicker column, **compact and
 * unruled** — the label column the boards' 84 px, the rows 6 px apart. The kit's `LabelRows` is the
 * record sheet's ruled list (each row on a dotted rule, 10 px of air); a block in an inspector that
 * sits beside another block wants the board's tighter one, so the two columns end near each other.
 */
type FactListProps = Omit<ComponentProps<'dl'>, 'children'> & {
  rows: ReadonlyArray<{ label: string; value: ReactNode; key?: string }>;
};

function FactList({ rows, className, ...props }: FactListProps) {
  return (
    <dl
      data-slot="fact-list"
      className={cn(
        'm-0 grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-(--space-2_5) gap-y-(--space-1_5)',
        className,
      )}
      {...props}
    >
      {rows.map((row) => (
        <div key={row.key ?? row.label} data-slot="fact" className="contents">
          <dt className="flex min-h-(--size-badge) items-start pt-[0.45em] text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
            {row.label}
          </dt>
          <dd className="m-0 flex min-h-(--size-badge) min-w-0 flex-col justify-center text-row leading-snug text-fg1">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export { FactList, type FactListProps };
