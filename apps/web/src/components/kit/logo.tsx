import type { ComponentProps } from 'react';

import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { cn } from '@/lib/utils';

/**
 * The Gli logo (custom; B01-3): the duotone mark the skater app's top bar wears, white on a dark
 * map and black on a light one. Both files ship and CSS picks one at paint, the way the app's own
 * theme resolves (`lib/theme.ts`):
 *
 * - **The nearest `data-mode` wins**, so a mark inside a scoped theme (a four-up quad, a light card
 *   on a dark page) wears its own scope's — one scope inside another included.
 * - **With no `data-mode` above it, the page's `.dark` decides.** That is how *system* is
 *   expressed: the attribute is removed, and the before-paint script and the theme provider keep
 *   `.dark` on `<html>` in step with the OS. No `.dark` and no mode means the light map's black.
 *
 * The precedence is carried by specificity, never by the order the rules land in the sheet: a
 * scope's rule repeats its attribute (one class's weight more than `.dark &`), and a scope inside a
 * scope adds one more, so the nearest always outweighs the farther. Two levels of scope are
 * resolved; a third inside them reads as its middle scope's.
 *
 * One image to a reader, named "Gli"; the two files are its drawing. Sized by its height (`h-…`),
 * its width following the mark's own proportion.
 */
const ON_DARK = cn(
  'hidden',
  // The page, with no scope: its resolved mode.
  '[.dark_&]:block',
  // One scope.
  '[[data-mode=light][data-mode=light]_&]:hidden',
  '[[data-mode=dark][data-mode=dark]_&]:block',
  // A scope inside a scope: the inner one.
  '[[data-mode=light]_[data-mode=dark][data-mode=dark]_&]:block',
  '[[data-mode=dark]_[data-mode=light][data-mode=light]_&]:hidden',
);
const ON_LIGHT = cn(
  'block',
  '[.dark_&]:hidden',
  '[[data-mode=light][data-mode=light]_&]:block',
  '[[data-mode=dark][data-mode=dark]_&]:hidden',
  '[[data-mode=light]_[data-mode=dark][data-mode=dark]_&]:hidden',
  '[[data-mode=dark]_[data-mode=light][data-mode=light]_&]:block',
);

type LogoProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** The accessible name. Default "Gli". */
  label?: string;
};

function Logo({ label = 'Gli', className, ...props }: LogoProps) {
  return (
    <span
      role="img"
      aria-label={label}
      data-slot="logo"
      className={cn('inline-flex h-(--space-4) shrink-0', className)}
      {...props}
    >
      <img
        src={logoWhite}
        alt=""
        data-slot="logo-on-dark"
        draggable={false}
        className={cn('h-full w-auto', ON_DARK)}
      />
      <img
        src={logoBlack}
        alt=""
        data-slot="logo-on-light"
        draggable={false}
        className={cn('h-full w-auto', ON_LIGHT)}
      />
    </span>
  );
}

export { Logo, type LogoProps };
