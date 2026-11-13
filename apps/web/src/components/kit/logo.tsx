import type { ComponentProps } from 'react';

import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { cn } from '@/lib/utils';

/**
 * The Gli logo (custom; B01-3): the duotone mark the skater app's top bar wears, white on a dark
 * map and black on a light one. Both files ship and **the nearest `data-mode` picks one at paint**
 * — not the page's `.dark` class — so a mark inside a scoped theme (a four-up quad, a light card on
 * a dark page) wears its own scope's. With no mode stated anywhere it is the dark map's white.
 *
 * One image to a reader, named "Gli"; the two files are its drawing. Sized by its height (`h-…`),
 * its width following the mark's own proportion.
 */
const ON_DARK = cn(
  'block',
  '[[data-mode=light]_&]:hidden',
  '[[data-mode=light]_[data-mode=dark]_&]:block',
);
const ON_LIGHT = cn(
  'hidden',
  '[[data-mode=light]_&]:block',
  '[[data-mode=light]_[data-mode=dark]_&]:hidden',
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
