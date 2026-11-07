import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFileLines, faMap } from '@fortawesome/sharp-light-svg-icons';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';

import { cn } from '@/lib/utils';

import { navLinkProps } from '../chrome';

/**
 * The phone's tab bar (row 9): Explore · New report · Latest under the thumb, docked to the bottom
 * of the screen. The lit destination wears a 2 px rule on the bar's top hairline; New report is the
 * one primary, an inverse block over its label. Explore and Latest are real links (a long press
 * still opens a tab); New report opens the sheet over the current page. Props only.
 */
export interface PhoneTabBarViewProps {
  /** The lit destination. */
  active: 'explore' | 'latest' | null;
  onNavigate: (href: string) => void;
  onNewReport: () => void;
  className?: string;
}

const ITEM = cn(
  'relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-(--space-1_5)',
  'rounded-control border-0 bg-transparent p-0 no-underline outline-none focus-visible:shadow-focus',
  'text-[0.59375rem] leading-none font-semibold tracking-head text-fg3 uppercase',
);

/** The lit rule: 56 px of the bar's top edge, over the lit item. */
const LIT =
  'text-fg before:absolute before:-top-px before:left-1/2 before:h-(--stroke-note) before:w-14 before:-translate-x-1/2 before:bg-fg';

export function PhoneTabBarView({
  active,
  onNavigate,
  onNewReport,
  className,
}: PhoneTabBarViewProps) {
  const link = (key: 'explore' | 'latest', href: string, label: string, icon: typeof faMap) => {
    const on = active === key;
    return (
      <a
        {...navLinkProps(href, onNavigate)}
        aria-current={on ? 'page' : undefined}
        data-slot="phone-tab"
        data-attr={`phone-tab-${key}`}
        className={cn(ITEM, on && LIT)}
      >
        <FontAwesomeIcon icon={icon} aria-hidden="true" className="h-4.5" />
        {label}
      </a>
    );
  };
  return (
    <nav
      aria-label="Main"
      data-slot="phone-tab-bar"
      className={cn(
        'fixed inset-x-0 bottom-0 z-(--z-raised) flex h-16 items-stretch',
        'border-0 border-t border-solid border-line bg-bg px-(--space-2) pb-(--space-2)',
        className,
      )}
    >
      {link('explore', '/', 'Explore', faMap)}
      <button
        type="button"
        data-slot="phone-tab"
        data-attr="new-report"
        onClick={onNewReport}
        className={cn(ITEM, 'flex-[1.15] text-fg1')}
      >
        <span
          aria-hidden="true"
          className="flex h-7.5 w-13 items-center justify-center rounded-control bg-inv-bg text-inv-fg"
        >
          <FontAwesomeIcon icon={faPlus} className="h-3.75" />
        </span>
        New report
      </button>
      {link('latest', '/latest', 'Latest', faFileLines)}
    </nav>
  );
}
