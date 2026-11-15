import type { ComponentProps } from 'react';

import { Avatar, type AvatarProps } from '@/components/kit/avatar';
import { SearchMark } from '@/components/kit/search-mark';
import { PersonName, personNameClass } from '@/components/PersonName';
import { cn } from '@/lib/utils';

/**
 * **A kit candidate** (People, B01): the person lockup — the boards' `.person`. A circle face, the
 * person's real name, and the handle; the one way the console names a person in a row, a feed or a
 * key/value line (Round 1: key "User" + this lockup).
 *
 * - **Real names, never usernames** (Round 2). The handle survives only inside the lockup, in mono
 *   with a dotted underline — **the link** to the public profile when `href` is given, which opens
 *   in a new tab (an app link always does). Inside a control that is itself the click target (a list
 *   row), pass no `href`: the handle keeps the link's look but is text, so the row holds the one
 *   action and a reader meets no control nested in another.
 * - **Circles for people**: the kit `Avatar`, hidden from readers beside the written name so the
 *   name isn't heard twice.
 * - **Never sent to analytics**: the name and the handle are `PersonName`-masked, and so is the
 *   face (its initials carry the name).
 * - **Sizes**: `md` — a list row's (the avatar's lockup size, the row's name step at medium
 *   weight); `sm` — in a feed or a line of text (the small avatar, the name in the surrounding ink
 *   and size).
 * - **`mark`** highlights what was searched, in the name and the handle, with the kit's search mark.
 * - The name's ink is inherited, so a selected row can brighten it; the handle stays quiet.
 */

type PersonLockupProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** The person's real name. */
  name: string;
  /** Their handle, without the `@`. */
  handle: string;
  /** A photo; the initials show until it loads. */
  src?: string | null | undefined;
  /** The public profile: the handle becomes its link, opened in a new tab. */
  href?: string | undefined;
  /** What was searched: marked where it matches the name or the handle. */
  mark?: string | undefined;
  size?: 'sm' | 'md';
};

const NAME = {
  md: 'text-body leading-(--lead-snug) font-medium',
  sm: '',
} as const;

const FACE: Record<'sm' | 'md', AvatarProps['size']> = { md: 'md', sm: 'sm' };

function PersonLockup({
  name,
  handle,
  src,
  href,
  mark = '',
  size = 'md',
  className,
  ...props
}: PersonLockupProps) {
  const handleText = (
    <>
      @<SearchMark text={handle} query={mark} />
    </>
  );
  const handleLook =
    'shrink-0 font-(family-name:--family-mono) text-mono-sm leading-none text-fg2 no-underline border-0 border-b border-dotted border-fg3 pb-px';
  return (
    <span
      data-slot="person-lockup"
      data-size={size}
      className={cn(
        'inline-flex min-w-0 items-baseline whitespace-nowrap',
        size === 'md' ? 'gap-(--space-2)' : 'gap-(--space-1_5)',
        className,
      )}
      {...props}
    >
      <Avatar
        name={name}
        {...(src != null && { src })}
        size={FACE[size]}
        aria-hidden="true"
        className={cn('self-center', personNameClass)}
      />
      <PersonName className={cn('min-w-0 truncate', NAME[size])}>
        <span data-slot="person-name">
          <SearchMark text={name} query={mark} />
        </span>
      </PersonName>
      <PersonName className="shrink-0">
        {href !== undefined ? (
          <a
            data-slot="person-handle"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(handleLook, 'hover:text-fg focus-visible:text-fg outline-none')}
          >
            {handleText}
          </a>
        ) : (
          <span data-slot="person-handle" className={handleLook}>
            {handleText}
          </span>
        )}
      </PersonName>
    </span>
  );
}

export { PersonLockup, type PersonLockupProps };
