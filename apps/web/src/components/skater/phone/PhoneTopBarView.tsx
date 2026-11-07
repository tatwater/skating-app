import type { ReactNode } from 'react';

import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { cn } from '@/lib/utils';

import { navLinkProps } from '../chrome';

/**
 * The phone's top bar (row 9, boards 9.1–9.7): the logo, the search field filling the space between
 * it and the bell, then you. Explore, Latest and New report move to the tab bar under the thumb;
 * the theme moves into the account sheet. Props only — the search, the bell and the account sheet
 * arrive as slots, each its own composition.
 */
export interface PhoneTopBarViewProps {
  /** A plain press on the logo, handed to the router. */
  onNavigate: (href: string) => void;
  search: ReactNode;
  notifications: ReactNode;
  avatar: ReactNode;
  className?: string;
}

export function PhoneTopBarView({
  onNavigate,
  search,
  notifications,
  avatar,
  className,
}: PhoneTopBarViewProps) {
  return (
    <header
      data-slot="phone-top-bar"
      className={cn(
        'relative z-(--z-raised) flex h-13 shrink-0 items-center gap-(--space-0_5)',
        'border-0 border-b border-solid border-line bg-bg pr-(--space-2_5) pl-(--space-4)',
        className,
      )}
    >
      <a
        {...navLinkProps('/', onNavigate)}
        data-slot="phone-logo"
        className="flex h-full shrink-0 items-center rounded-control outline-none focus-visible:shadow-focus"
      >
        {/* Both marks ship and `.dark` picks one at paint, as on the desktop bar. */}
        <img src={logoBlack} alt="Gli" className="block h-5 w-auto dark:hidden" />
        <img src={logoWhite} alt="Gli" className="hidden h-5 w-auto dark:block" />
      </a>
      <div
        data-slot="phone-search-slot"
        className="mr-(--space-1_5) ml-(--space-3_5) flex min-w-0 flex-1"
      >
        {search}
      </div>
      {notifications}
      {avatar}
    </header>
  );
}
