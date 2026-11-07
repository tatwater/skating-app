import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Avatar } from './avatar';
import { Badge } from './badge';
import { Kbd } from './kbd';

/**
 * The console rail's mode item (admin only): the left rail's link to one mode — an icon over its
 * name, the mode's count in a corner badge.
 *
 * - **Icon over name.** The icon is the rail step's 20 px glyph (rem, so it grows with the reader's
 *   font size); the name sits 5 px under it in **8 px caps** (`text-rail`) — the one type step under
 *   the console's floor, kept by the founder's call for the rail, its badges and avatar initials.
 *   The name's trailing tracking is given back on its left, so the word centers on the icon.
 * - **The count** is a square mono badge pinned 6 px down and 4 px in from the item's top right
 *   corner, so every badge on the rail shares one right edge: gray (a plain count), amber (waiting on
 *   a person), red (something failed). No count, no badge — never a `0`.
 * - **On** (`current`): the bright ink, and a 2 px white bar on the rail's edge with the white glow.
 *   The link says so to a reader (`aria-current="page"`).
 * - **Hover and keyboard focus are one look** (the console's rule): the name and icon brighten;
 *   focus adds a hairline ring inside the item, so it never spills over its neighbors.
 * - **Go-mode** (`go`): G was pressed. Every item steps up to the quiet-bright ink, the count hides
 *   (its place is taken by the go chip — the ice key with the spent G grayed before the finishing
 *   letter), and the current mode stays full bright.
 * - **The app item** (`variant="app"`) is another place: shorter, in the quiet-bright ink, the
 *   new-tab mark for its icon and a hairline over it; it always opens in a new tab.
 * - **No tooltips, ever** — this is navigation. A name that needs explaining is renamed.
 * - **Routing is the caller's**: the item renders an `<a>` by default; pass the router's link as
 *   `render` (`render={<Link to="/inbox" />}`) and it takes the item's props and children.
 */

type RailCountTone = 'default' | 'warn' | 'bad';

type RailItemProps = Omit<useRender.ComponentProps<'a'>, 'children'> & {
  /** The mode's glyph (a FontAwesome Sharp Light icon). */
  icon: ReactNode;
  /** The mode's name, written capitalized ("Inbox"); the rail sets it in caps. */
  name: string;
  /** This is the mode on screen. */
  current?: boolean;
  /** What's waiting in the mode ("19", "1.2k"). Leave it out when nothing is — never `0`. */
  count?: number | string;
  /** Gray, amber (waiting on a person) or red (something failed). */
  countTone?: RailCountTone;
  /** What a reader hears for the count ("19 need a person"), in place of the bare number. */
  countLabel?: string;
  /** `app`: the other place — a new tab, the new-tab mark, a hairline over it. */
  variant?: 'mode' | 'app';
  /** Go-mode is on: the count hides and the go chip shows. */
  go?: boolean;
  /** The letter that finishes the jump in go-mode ("I" for Inbox). */
  goKey?: string;
};

function RailItem({
  icon,
  name,
  current = false,
  count,
  countTone = 'default',
  countLabel,
  variant = 'mode',
  go = false,
  goKey,
  className,
  render,
  ...props
}: RailItemProps) {
  const app = variant === 'app';
  const hasCount = !app && count !== undefined && count !== '';
  const children = (
    <>
      <span
        data-slot="rail-icon"
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 items-center justify-center',
          app
            ? 'size-[0.9375rem] [&_svg]:size-[0.9375rem]'
            : 'size-(--space-5) [&_svg]:size-(--space-5)',
        )}
      >
        {icon}
      </span>
      <span
        data-slot="rail-name"
        className="ps-(--track-rail) text-rail leading-none font-medium tracking-rail whitespace-nowrap uppercase"
      >
        {name}
      </span>
      {hasCount && (
        <Badge
          data-slot="rail-count"
          data-tone={countTone}
          tone={countTone}
          aria-hidden={countLabel !== undefined ? true : undefined}
          className={cn(
            // Square, mono, 8 px — em lengths, so the box tracks its own type: 12 tall, 14 wide.
            'absolute top-(--space-1_5) right-(--space-1) h-[1.5em] min-w-[1.75em] justify-center px-[0.375em]',
            'text-rail font-semibold tracking-normal',
            countTone === 'default' && 'bg-fg2',
            go && 'invisible',
          )}
        >
          {count}
        </Badge>
      )}
      {hasCount && countLabel !== undefined && <span className="sr-only">{countLabel}</span>}
      {go && goKey !== undefined && (
        <Kbd
          data-slot="rail-go"
          variant="go"
          spent="G"
          aria-hidden="true"
          className="absolute top-[0.3125rem] right-[0.1875rem]"
        >
          {goKey}
        </Kbd>
      )}
      {app && <span className="sr-only">(opens in a new tab)</span>}
    </>
  );

  return useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>(
      {
        'aria-current': current && !app ? 'page' : undefined,
        ...(app ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        className: cn(
          'relative flex w-full flex-col items-center justify-center gap-[0.3125rem] outline-none select-none',
          'text-fg3 no-underline',
          'transition-colors duration-(--duration-fast) ease-standard',
          'lit:text-fg1 focus-visible:inset-ring-1 focus-visible:inset-ring-fg',
          app
            ? [
                'mb-(--space-2) h-[2.875rem] text-fg2',
                // The hairline over the app item, 18 px in from each side.
                'after:absolute after:inset-x-(--space-4_5) after:-top-(--space-1_5) after:h-(--stroke-hair) after:bg-line after:content-[""]',
              ]
            : 'h-rail-item',
          go && !current && 'text-fg2',
          current && [
            'text-fg lit:text-fg',
            // The on bar: 2 px (a stroke, so px) by 24 px, on the rail's edge, glowing.
            'before:absolute before:top-1/2 before:left-0 before:h-(--space-6) before:w-(--stroke-note) before:-translate-y-1/2',
            'before:bg-fg before:shadow-glow-w before:content-[""]',
          ],
          className,
        ),
        children,
      },
      props as ComponentProps<'a'>,
    ),
    state: { slot: 'rail-item', current, variant, go },
  });
}

type RailViewerProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The viewer's real name: the initials and the accessible name. */
  name: string;
  /** A photo URL; the initials show until it loads. */
  src?: string;
};

/**
 * The viewer at the rail's foot: the person circle (people are circles), 26 px on the console, in
 * the viewer tone — a raised ground, a quiet ring, the bright-body initials. No tooltip (the rail is
 * navigation); the name is the circle's accessible name.
 */
function RailViewer({ name, src, className, ...props }: RailViewerProps) {
  return (
    <div data-slot="rail-viewer" className={cn('flex justify-center', className)} {...props}>
      <Avatar name={name} size="lg" tone="viewer" {...(src !== undefined ? { src } : {})} />
    </div>
  );
}

export { RailItem, type RailItemProps, RailViewer, type RailViewerProps };
