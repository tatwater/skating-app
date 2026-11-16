import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Kit candidate — label rows** (the record sheet's *If overturned*, *If kept*, *Comes back with
 * it*, 8.7–8.8): short facts read down a label column — a kicker on the left (*Record*, *Comment*,
 * *Erased*), what it says on the right. A list of terms (`dl`), each row on a dotted rule, the last
 * with none; the label column is the boards' 76 px.
 */

type LabelRowsProps = Omit<ComponentProps<'dl'>, 'children'> & {
  rows: ReadonlyArray<{ label: string; value: ReactNode }>;
};

function LabelRows({ rows, className, ...props }: LabelRowsProps) {
  return (
    <dl data-slot="label-rows" className={cn('m-0 flex flex-col', className)} {...props}>
      {rows.map((row) => (
        <div
          key={row.label}
          data-slot="label-row"
          className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-(--space-2_5) border-0 border-b-(length:--stroke-hair) border-dotted border-line py-(--space-2_5) last:border-b-0"
        >
          <dt className="pt-(--space-1) text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
            {row.label}
          </dt>
          <dd className="m-0 min-w-0 text-row leading-body text-fg2">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export { LabelRows, type LabelRowsProps };
