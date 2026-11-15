import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Avatar } from './avatar';

/**
 * The boards' `.person` lockup: a person's circle, their real name, then their
 * @handle — the one place a handle survives (Round 2 #1), and the link to their page when there
 * is one. Whoever took an action stands on their own line under it, as this.
 *
 * - **A circle for a person** (`Avatar`, its initials hidden from a reader: the name beside it is
 *   the accessible name, said once).
 * - **`sm`** is the list size (the row step); the default is the body step.
 */

type PersonLockupProps = Omit<ComponentProps<'span'>, 'children'> & {
  name: string;
  /** Without the @. */
  handle?: string;
  /** Their page; the handle becomes the link. */
  href?: string;
  size?: 'sm' | 'md';
};

function PersonLockup({ name, handle, href, size = 'sm', className, ...props }: PersonLockupProps) {
  const at = handle !== undefined ? `@${handle}` : null;
  return (
    <span
      data-slot="person-lockup"
      className={cn(
        'inline-flex min-w-0 items-center gap-(--space-2) whitespace-nowrap',
        size === 'sm' ? 'text-assist leading-list' : 'text-row leading-list',
        className,
      )}
      {...props}
    >
      <Avatar name={name} size="sm" aria-hidden="true" />
      <span data-slot="person-name" className="truncate text-fg2">
        {name}
      </span>
      {at !== null &&
        (href !== undefined ? (
          <a
            data-slot="person-handle"
            href={href}
            className="text-fg3 underline-offset-2 hover:underline"
          >
            {at}
          </a>
        ) : (
          <span data-slot="person-handle" className="text-fg3">
            {at}
          </span>
        ))}
    </span>
  );
}

export { PersonLockup, type PersonLockupProps };
