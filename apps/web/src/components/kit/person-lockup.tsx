import type { ComponentProps } from 'react';
import { PersonName, personNameClass } from '@/components/PersonName';
import { cn } from '@/lib/utils';
import { Avatar, type AvatarProps } from './avatar';
import { SearchMark } from './search-mark';

/**
 * The boards' `.person` lockup: a person's circle, their real name, then their
 * @handle — the one place a handle survives (Round 2 #1), and the link to their page when there
 * is one. Whoever took an action stands on their own line under it, as this.
 *
 * - **A circle for a person** (`Avatar`, its initials hidden from a reader: the name beside it is
 *   the accessible name, said once). A photo, when given, replaces the initials once it loads.
 * - **Sizes.** `sm` is the list size (the row step) and `md` the body step, for a person named in
 *   a block. `row` is a person list's row (the lockup's own face, the name at medium weight, the
 *   handle in mono over a dotted rule — `.row .t .person`). `head` is the person a page is about
 *   (`.person.xl`): the head's face, the name in tracked caps over the handle.
 * - **`nameAs`** makes the name a heading, at the level its page needs (the person page's `h2`).
 * - **`mark`** highlights what was searched in the name and the handle (the kit's search mark).
 * - **Never sent to analytics**: the name, the handle and the face are `PersonName`-masked (the
 *   face's initials carry the name).
 */

type Size = 'sm' | 'md' | 'row' | 'head';

type PersonLockupProps = Omit<ComponentProps<'span'>, 'children'> & {
  name: string;
  /** Without the @. */
  handle?: string | undefined;
  /** Their page; the handle becomes the link. */
  href?: string | undefined;
  size?: Size;
  /** A photo; the initials show until it loads. */
  src?: string | null | undefined;
  /** What was searched: marked where it matches the name or the handle. */
  mark?: string | undefined;
  /** The element the name is: a heading for the person a page is about. */
  nameAs?: 'span' | 'h1' | 'h2';
};

const BOX: Record<Size, string> = {
  sm: 'items-center gap-(--space-2) text-assist leading-list',
  md: 'items-center gap-(--space-2) text-row leading-list',
  row: 'items-baseline gap-(--space-2)',
  head: 'items-center gap-(--space-2_5)',
};

const FACE: Record<Size, Pick<AvatarProps, 'size' | 'tone'>> = {
  sm: { size: 'sm' },
  md: { size: 'sm' },
  row: { size: 'md' },
  head: { size: 'xl', tone: 'head' },
};

const NAME: Record<Size, string> = {
  sm: 'text-fg2',
  md: 'text-fg2',
  // The name's ink is inherited in a row, so a selected row can brighten it.
  row: 'text-body leading-(--lead-snug) font-medium',
  // The boards' 15 px tracked caps: the type scale's 15 px step is the logo's (no name step).
  head: 'm-0 text-logo leading-none font-semibold tracking-rail text-fg uppercase',
};

/** The boards' `.person .h`: mono, over a dotted rule. */
const MONO_HANDLE =
  'font-(family-name:--family-mono) text-mono-sm leading-none text-fg2 border-0 border-b border-dotted border-fg3 pb-px';

const HANDLE: Record<Size, string> = {
  sm: 'text-fg3',
  md: 'text-fg3',
  row: MONO_HANDLE,
  head: MONO_HANDLE,
};

function PersonLockup({
  name,
  handle,
  href,
  size = 'sm',
  src,
  mark = '',
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
  const at =
    handle === undefined ? null : (
      <>
        @<SearchMark text={handle} query={mark} />
      </>
    );
  const handleEl =
    at === null ? null : (
      <PersonName className="shrink-0">
        {href !== undefined ? (
          <a
            data-slot="person-handle"
            href={href}
            className={cn(HANDLE[size], 'underline-offset-2 hover:underline')}
          >
            {at}
          </a>
        ) : (
          <span data-slot="person-handle" className={HANDLE[size]}>
            {at}
          </span>
        )}
      </PersonName>
    );
  return (
    <span
      data-slot="person-lockup"
      data-size={size}
      className={cn('inline-flex min-w-0 whitespace-nowrap', BOX[size], className)}
      {...props}
    >
      <Avatar
        name={name}
        {...(src != null && { src })}
        {...FACE[size]}
        aria-hidden="true"
        className={cn('self-center', personNameClass)}
      />
      {size === 'head' ? (
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
