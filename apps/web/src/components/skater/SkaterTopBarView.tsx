import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';
import type { ReactNode } from 'react';

import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { cn } from '@/lib/utils';

import { Button } from '../kit/button';
import { navLinkProps } from './chrome';
import { INK_PRIMARY } from './styles';

/**
 * The skater top bar (row 1's top strip; boards 3.17, 3.21, 3.24): the logo, Explore and Latest,
 * search in the middle, then the one primary — New report — the bell and the avatar. Props only:
 * the search, the bell and the avatar arrive as slots, each its own composition, so this is the
 * bar's layout and nothing else.
 */
export interface SkaterTopBarViewProps {
  /** The lit top-level link. */
  active: 'explore' | 'latest' | null;
  /** A plain press on a link, handed to the router. */
  onNavigate: (href: string) => void;
  /** New report: opens the sheet over the current page. */
  onNewReport: () => void;
  search: ReactNode;
  notifications: ReactNode;
  avatar: ReactNode;
  className?: string;
}

const NAV = [
  { key: 'explore', label: 'Explore', href: '/' },
  { key: 'latest', label: 'Latest', href: '/latest' },
] as const;

export function SkaterTopBarView({
  active,
  onNavigate,
  onNewReport,
  search,
  notifications,
  avatar,
  className,
}: SkaterTopBarViewProps) {
  return (
    <header
      data-slot="skater-top-bar"
      className={cn(
        'relative z-(--z-raised) flex h-top shrink-0 items-center gap-bar-gap',
        'border-0 border-b border-solid border-line bg-bg pr-(--space-5) pl-bar-x',
        className,
      )}
    >
      <a
        {...navLinkProps('/', onNavigate)}
        data-slot="skater-logo"
        className="flex h-full shrink-0 items-center rounded-control outline-none focus-visible:shadow-focus"
      >
        {/* Both marks ship and the `.dark` class picks one at paint (the theme init script sets
            it before hydration), so the right mark is there on the first frame. */}
        <img src={logoBlack} alt="Gli" className="block h-[1.375rem] w-auto dark:hidden" />
        <img src={logoWhite} alt="Gli" className="hidden h-[1.375rem] w-auto dark:block" />
      </a>

      <nav aria-label="Main" className="flex h-full gap-(--space-1)">
        {NAV.map((item) => {
          const on = active === item.key;
          return (
            <a
              key={item.key}
              {...navLinkProps(item.href, onNavigate)}
              aria-current={on ? 'page' : undefined}
              data-slot="skater-nav-link"
              className={cn(
                'relative flex items-center px-(--space-3_5) outline-none',
                'text-kick leading-none font-medium tracking-head uppercase no-underline',
                'text-fg2 transition-colors duration-(--duration-fast) ease-standard lit:text-fg',
                'focus-visible:shadow-focus',
                // The lit page wears a 2 px rule on the bar's own hairline.
                'after:absolute after:inset-x-(--space-3_5) after:-bottom-px after:h-(--stroke-note) after:bg-fg after:opacity-0',
                on && 'text-fg after:opacity-100',
              )}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      <div data-slot="skater-search-slot" className="flex min-w-0 flex-1 justify-center">
        {search}
      </div>

      <div data-slot="skater-top-right" className="flex shrink-0 items-center gap-(--space-1_5)">
        <Button
          variant="primary"
          data-attr="new-report"
          onClick={onNewReport}
          className={cn(INK_PRIMARY, 'mr-(--space-2_5)')}
        >
          <FontAwesomeIcon icon={faPlus} aria-hidden="true" className="h-[1.1em]" />
          New report
        </Button>
        {notifications}
        {avatar}
      </div>
    </header>
  );
}
