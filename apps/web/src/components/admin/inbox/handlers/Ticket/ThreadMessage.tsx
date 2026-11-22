import type { ComponentProps, ReactNode } from 'react';

import { Avatar } from '@/components/kit/avatar';
import { cn } from '@/lib/utils';

/**
 * **One message in a thread** (board 2.8's `.msg`) — a kit candidate, built beside the ticket
 * handler (promoted at integration, if the kit's writer takes it): a person's circle, their name, a
 * kicker after it, the time at the row's end, and what they wrote under it.
 *
 * - **A circle for a person** (`Avatar`, initials hidden from a reader: the name beside it is said
 *   once). Someone gone has no initials to show: `face={null}` draws the bare circle.
 * - **`staff`**: a note only staff see — its words in the dashed staff box, a step quieter.
 * - **`status`**: a line under the words (a reply's *Sending in 42 s · Cancel*, *Not sent · …*).
 * - The words keep their line breaks and wrap anywhere a long run would push the pane sideways.
 */
type ThreadMessageProps = Omit<ComponentProps<'article'>, 'children'> & {
  /** Who wrote it, as the page may name them. */
  name: string;
  /** The circle's initials come from this name; `null` draws the circle bare (someone gone). */
  face: string | null;
  /** After the name ("Note · staff only"). */
  kicker?: ReactNode;
  /** The row's end: when it was written. */
  at: ReactNode;
  /** A staff-only note: the dashed box. */
  staff?: boolean;
  /** A line under the words. */
  status?: ReactNode;
  children: ReactNode;
};

function ThreadMessage({
  name,
  face,
  kicker,
  at,
  staff = false,
  status,
  children,
  className,
  ...props
}: ThreadMessageProps) {
  return (
    <article
      data-slot="thread-message"
      data-thread-message=""
      data-staff={staff ? '' : undefined}
      className={cn(
        'grid min-w-0 grid-cols-[var(--size-avatar-lg)_minmax(0,1fr)] gap-x-(--space-3)',
        className,
      )}
      {...props}
    >
      {face === null ? (
        <span
          aria-hidden="true"
          data-slot="thread-message-face"
          className="size-avatar-lg rounded-full border border-dashed border-line2"
        />
      ) : (
        <Avatar data-slot="thread-message-face" name={face} size="lg" aria-hidden="true" />
      )}
      <div className="flex min-w-0 flex-col gap-(--space-1)">
        <header className="flex min-h-(--size-avatar-lg) min-w-0 flex-wrap items-center gap-x-(--space-2_5) gap-y-(--space-1)">
          <span
            data-slot="thread-message-name"
            className="text-row leading-none font-medium text-fg"
          >
            {name}
          </span>
          {kicker !== undefined && (
            <span
              data-slot="thread-message-kicker"
              className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
            >
              {kicker}
            </span>
          )}
          <span
            data-slot="thread-message-at"
            className="ms-auto font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3 uppercase"
          >
            {at}
          </span>
        </header>
        <div
          data-slot="thread-message-body"
          className={cn(
            'min-w-0 leading-body break-words whitespace-pre-wrap',
            staff
              ? 'border border-dashed border-line2 px-(--space-3) py-(--space-2_5) text-row text-fg2'
              : 'text-body text-fg',
          )}
        >
          {children}
        </div>
        {status !== undefined && (
          <div
            data-slot="thread-message-status"
            className="flex min-w-0 flex-wrap items-center gap-x-(--space-2_5) gap-y-(--space-1) text-assist leading-list text-fg3"
          >
            {status}
          </div>
        )}
      </div>
    </article>
  );
}

/** A line across the thread between messages (2.8's `.evt`): "A note was removed". */
function ThreadEvent({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="thread-event"
      className={cn(
        'ms-[calc(var(--size-avatar-lg)+var(--space-3))] flex items-center gap-(--space-2_5)',
        'text-kick leading-none font-medium tracking-kick text-fg3 uppercase',
        "after:h-px after:flex-1 after:bg-line after:content-['']",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { ThreadEvent, ThreadMessage, type ThreadMessageProps };
