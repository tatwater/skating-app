import type { ComponentProps } from 'react';

import {
  LifeKey,
  type LifeLine,
  type LifeLineMeaning,
  type LifeStation,
} from '@/components/kit/life-strip';
import { cn } from '@/lib/utils';

/**
 * **Kit candidate — its life, top to bottom** (the record sheet on a narrow screen, 8.9): the kit
 * `LifeStrip`'s stations and lines, read down the page instead of across — the date in a column of
 * its own, the rail beside it, what happened and who beside that. Same stations, same marks, same
 * line weights and the same key, so a reader learns one strip.
 *
 * - **The line under a station is the state it left the item in**, drawn down the rail to the next
 *   station; how long it lasted follows the station's words.
 * - Promote it beside `LifeStrip` (an `orientation` of the same piece) when the kit pass comes.
 */

/** A line down the rail: a zero-width box whose left border is the stroke. */
const LINE: Record<LifeLine, string> = {
  thin: 'border-l-(length:--stroke-hair) border-solid border-fg3',
  heavy: 'border-l-(length:--stroke-run) border-solid border-fg',
  dashed: 'border-l-(length:--stroke-note) border-dashed border-fg2',
};

const MARK: Record<LifeStation['mark'], string> = {
  dot: 'size-(--space-2_5) rounded-full bg-fg2',
  hollow: 'size-(--space-2_5) rounded-full bg-bg inset-ring-2 inset-ring-fg2',
  ring: 'size-(--space-2_5) rounded-full bg-bg inset-ring-2 inset-ring-fg',
  square: 'size-(--space-2_5) bg-fg',
  warn: 'size-(--space-2_5) bg-warn',
  now: 'size-(--space-2_5) bg-fg',
  end: 'size-(--space-2_5) rounded-full bg-bg inset-ring inset-ring-fg3',
};

const TONE: Partial<Record<LifeStation['mark'], string>> = {
  now: 'text-fg',
  warn: 'text-warn',
  end: 'text-fg3',
};

type LifeListProps = Omit<ComponentProps<'div'>, 'children'> & {
  stations: readonly LifeStation[];
  lines: readonly LifeLineMeaning[];
  'aria-label': string;
  showKey?: boolean;
};

function LifeList({
  stations,
  lines,
  showKey = true,
  className,
  'aria-label': label,
  ...props
}: LifeListProps) {
  const meaning = (line: LifeLine) => lines.find((l) => l.line === line)?.label;
  return (
    <div
      data-slot="life-list"
      className={cn('flex flex-col gap-(--space-2)', className)}
      {...props}
    >
      <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
        {stations.map((station, i) => {
          const last = i === stations.length - 1;
          const said = station.next === undefined ? undefined : meaning(station.next);
          return (
            <li
              // Stations are a sequence: a station's place is its identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              key={i}
              data-slot="life-list-station"
              data-mark={station.mark}
              className="grid grid-cols-[6.75rem_var(--space-3_5)_minmax(0,1fr)] gap-x-(--space-2_5)"
            >
              <span
                className={cn(
                  'pt-(--space-0_5) text-kick leading-none font-semibold tracking-kick text-fg3 uppercase',
                  station.mark === 'now' && 'text-fg',
                  station.mark === 'warn' && 'text-warn',
                )}
              >
                {station.when}
              </span>
              <span aria-hidden="true" className="relative flex justify-center">
                <span
                  className={cn('relative z-1 mt-(--space-0_5) block shrink-0', MARK[station.mark])}
                />
                {!last && station.next !== undefined && (
                  <i
                    data-slot="life-list-line"
                    data-line={station.next}
                    className={cn(
                      'absolute top-(--space-3_5) bottom-0 left-1/2 w-0 -translate-x-1/2',
                      LINE[station.next],
                    )}
                  />
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-(--space-0_5) pb-(--space-3)">
                <span
                  className={cn('text-row leading-snug font-medium text-fg2', TONE[station.mark])}
                >
                  {station.title}
                </span>
                {station.sub != null && (
                  <span className="text-assist leading-list text-fg3">{station.sub}</span>
                )}
                {!last && station.lasted != null && (
                  <span className="font-(family-name:--family-mono) text-mono-sm leading-none text-fg3">
                    {station.lasted}
                  </span>
                )}
                {!last && said !== undefined && <span className="sr-only">{`Then: ${said}`}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {showKey && <LifeKey lines={lines} />}
    </div>
  );
}

export { LifeList, type LifeListProps };
