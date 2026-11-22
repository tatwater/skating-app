import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * **The item timeline** (the Inbox's 2.2, its claims and ruling): a vertical timeline of
 * events — a date column, a node with its mark on a hairline that runs down to the next, and the
 * event itself. The boards' `.tl`: dates in mono caps right-aligned in a 46 px column, a 9 px square
 * mark whose ink is its meaning, the line in the rule gray.
 *
 * - **Marks by meaning only**: `bad` (a claim against the standing — the red), `bright` (the
 *   standing fact, solid in the bright ink), `quiet` (what's past — the rule gray).
 * - **The last event has no line under it**; a reader hears an ordered list.
 * - Content is the caller's: a head line, a person, a quote — the kit's `PersonLockup` and words.
 */

type ItemTimelineMark = 'bad' | 'bright' | 'quiet';

type ItemTimelineEvent = {
  key: string;
  /** The event's date as a line writes it ("13 Oct"); set in mono caps. */
  date: ReactNode;
  mark: ItemTimelineMark;
  children: ReactNode;
};

const MARK: Record<ItemTimelineMark, string> = {
  bad: 'bg-bad',
  bright: 'bg-fg',
  quiet: 'bg-line2',
};

type ItemTimelineProps = Omit<ComponentProps<'ol'>, 'children'> & {
  events: readonly ItemTimelineEvent[];
};

function ItemTimeline({ events, className, ...props }: ItemTimelineProps) {
  return (
    <ol
      data-slot="item-timeline"
      className={cn('m-0 flex list-none flex-col p-0', className)}
      {...props}
    >
      {events.map((e, i) => (
        <li
          key={e.key}
          data-slot="item-timeline-event"
          data-mark={e.mark}
          className="grid grid-cols-[2.875rem_0.75rem_minmax(0,1fr)] gap-x-(--space-3)"
        >
          <span
            data-slot="item-timeline-date"
            className="text-right font-(family-name:--family-mono) text-kick leading-[1.125rem] whitespace-nowrap text-fg3 uppercase"
          >
            {e.date}
          </span>
          <span aria-hidden="true" className="relative">
            {i < events.length - 1 && (
              <i
                data-slot="item-timeline-line"
                className="absolute top-(--space-4) bottom-0 left-[5px] w-(--stroke-hair) bg-line"
              />
            )}
            <i
              data-slot="item-timeline-mark"
              className={cn('absolute top-[5px] left-px size-[9px]', MARK[e.mark])}
            />
          </span>
          <div
            data-slot="item-timeline-body"
            className="flex min-w-0 flex-col gap-(--space-1_5) pb-(--space-4)"
          >
            {e.children}
          </div>
        </li>
      ))}
    </ol>
  );
}

export { ItemTimeline, type ItemTimelineEvent, type ItemTimelineMark, type ItemTimelineProps };
