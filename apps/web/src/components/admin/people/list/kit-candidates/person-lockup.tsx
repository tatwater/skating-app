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
 *   and size, the handle usually left out); `xl` — the person a page is about (the head's face, the
 *   name in tracked caps over the handle). `nameAs` makes the name a heading at the level its page
 *   needs.
 * - **`mark`** highlights what was searched, in the name and the handle, with the kit's search mark.
 * - The name's ink is inherited, so a selected row can brighten it; the handle stays quiet.
 */

type Size = 'sm' | 'md' | 'xl';

type PersonLockupProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** The person's real name. */
  name: string;
  /** Their handle, without the `@`; a feed's actor goes without one (`.person.sm`). */
  handle?: string | undefined;
  /** A photo; the initials show until it loads. */
  src?: string | null | undefined;
  /** The public profile: the handle becomes its link, opened in a new tab. */
  href?: string | undefined;
  /** What was searched: marked where it matches the name or the handle. */
  mark?: string | undefined;
  /**
   * `sm` in a line of text (a feed's actor), `md` a list row's, `xl` the person a page is about —
   * the name over the handle, beside the head's face (`.person.xl`).
   */
  size?: Size;
  /** The element the name is: the page's heading for the person a page is about. */
  nameAs?: 'span' | 'h1' | 'h2';
};

const NAME: Record<Size, string> = {
  sm: '',
  md: 'text-body leading-(--lead-snug) font-medium',
  // The boards' 15 px tracked caps: the type scale's 15 px step is the logo's (no name step).
  xl: 'm-0 text-logo leading-none font-semibold tracking-rail text-fg uppercase',
};

const FACE: Record<Size, Pick<AvatarProps, 'size' | 'tone'>> = {
  sm: { size: 'sm' },
  md: { size: 'md' },
  xl: { size: 'xl', tone: 'head' },
};

const GAP: Record<Size, string> = {
  sm: 'gap-(--space-1_5)',
  md: 'gap-(--space-2)',
  xl: 'gap-(--space-2_5)',
};

const HANDLE =
  'shrink-0 font-(family-name:--family-mono) text-mono-sm leading-none text-fg2 no-underline border-0 border-b border-dotted border-fg3 pb-px';

function PersonLockup({
  name,
  handle,
  src,
  href,
  mark = '',
  size = 'md',
  nameAs = 'span',
  className,
  ...props
}: PersonLockupProps) {
  const Name = nameAs;
  const nameEl = (
    <Name data-slot="person-name" className={cn('min-w-0 truncate', NAME[size])}>
      <PersonName>
        <SearchMark text={name} query={mark} />
      </PersonName>
    </Name>
  );
  const handleEl =
    handle === undefined ? null : (
      <PersonName className="shrink-0">
        {href !== undefined ? (
          <a
            data-slot="person-handle"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(HANDLE, 'outline-none hover:text-fg focus-visible:text-fg')}
          >
            @<SearchMark text={handle} query={mark} />
          </a>
        ) : (
          <span data-slot="person-handle" className={HANDLE}>
            @<SearchMark text={handle} query={mark} />
          </span>
        )}
      </PersonName>
    );
  return (
    <span
      data-slot="person-lockup"
      data-size={size}
      className={cn(
        'inline-flex min-w-0 whitespace-nowrap',
        size === 'xl' ? 'items-center' : 'items-baseline',
        GAP[size],
        className,
      )}
      {...props}
    >
      <Avatar
        name={name}
        {...(src != null && { src })}
        {...FACE[size]}
        aria-hidden="true"
        className={cn('self-center', personNameClass)}
      />
      {size === 'xl' ? (
        <span className="flex min-w-0 flex-col items-start gap-(--space-1_5)">
          {nameEl}
          {handleEl}
        </span>
      ) : (
        <>
          {nameEl}
          {handleEl}
        </>
      )}
    </span>
  );
}

export { PersonLockup, type PersonLockupProps };
