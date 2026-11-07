import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRightFromBracket,
  faArrowUpRightFromSquare,
  faCircleInfo,
  faGear,
  faShieldHalved,
  faUser,
} from '@fortawesome/sharp-light-svg-icons';
import type { ThemePreference } from '@skating/design';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Avatar } from '../../kit/avatar';
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '../../kit/drawer';
import { type AvatarMenuPerson, MODERATION_HREF } from '../AvatarMenuView';
import { navLinkProps } from '../chrome';
import { ThemeMenu } from '../ThemeMenu';

/**
 * The account sheet (board 9.5): the avatar menu as a bottom sheet on a phone. The same rows as the
 * desktop menu — who you are, your profile, Settings, About, Moderation for moderators (the
 * console, in a **new tab**), the theme as the three-way picker, and Sign out — at a thumb's height
 * (48 px rows). A modal kit Drawer over a scrim: a swipe down, a press on the scrim, or Esc closes
 * it, and focus returns to the avatar. Props only.
 */
export interface PhoneMenuSheetViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: AvatarMenuPerson;
  isModerator: boolean;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onNavigate: (href: string) => void;
  onSignOut: () => void;
  /** Scope the sheet to a container (stories). */
  container?: HTMLElement | null;
}

const ROW = cn(
  'flex h-12 w-full cursor-pointer items-center gap-(--space-3) border-0 bg-transparent px-(--space-4)',
  'rounded-control text-left text-body text-fg1 no-underline outline-none',
  'transition-colors duration-(--duration-instant) ease-standard hover:bg-raise focus-visible:bg-raise focus-visible:shadow-focus',
);
const ICON = 'h-3.5 w-3.5 shrink-0 text-fg2';
const RULE = 'my-(--space-1_5) border-0 border-t border-solid border-line';

export function PhoneMenuSheetView({
  open,
  onOpenChange,
  person,
  isModerator,
  theme,
  onThemeChange,
  onNavigate,
  onSignOut,
  container,
}: PhoneMenuSheetViewProps) {
  const go = (href: string) => navLinkProps(href, onNavigate);
  const profileHref = `/u/${encodeURIComponent(person.username)}`;
  const row = (href: string, icon: typeof faUser, label: ReactNode, attr: string) => (
    <a {...go(href)} data-attr={attr} className={ROW}>
      <FontAwesomeIcon icon={icon} aria-hidden="true" className={ICON} />
      {label}
    </a>
  );
  return (
    <Drawer open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DrawerTrigger
        data-attr="avatar"
        aria-label="Your account"
        // Initials are a person's: never autocaptured (D240).
        className={cn(
          'ph-no-capture ml-(--space-1_5) inline-flex shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 outline-none',
          'focus-visible:shadow-focus',
        )}
      >
        <Avatar
          name={person.name}
          {...(person.imageUrl ? { src: person.imageUrl } : {})}
          tone="viewer"
          aria-hidden="true"
          className={cn(open && 'border-fg')}
        />
      </DrawerTrigger>
      <DrawerContent
        container={container}
        data-slot="phone-menu-sheet"
        className="ph-no-capture bg-panel pb-(--space-6)"
      >
        <DrawerTitle className="sr-only">Your account</DrawerTitle>
        <div
          data-slot="phone-menu-who"
          className="mb-(--space-1_5) flex items-center gap-(--space-3) border-0 border-b border-solid border-line px-(--space-4) pt-(--space-1) pb-(--space-3_5)"
        >
          <Avatar
            name={person.name}
            {...(person.imageUrl ? { src: person.imageUrl } : {})}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-col gap-(--space-0_5)">
            <span className="truncate text-row leading-(--lead-snug) font-medium text-fg">
              {person.name}
            </span>
            <span className="truncate font-(family-name:--family-mono) text-mono-sm leading-(--lead-snug) text-fg2">
              @{person.username}
            </span>
          </span>
        </div>
        <nav aria-label="Your account" className="flex flex-col">
          {row(profileHref, faUser, 'Your profile', 'phone-menu-profile')}
          {row('/settings', faGear, 'Settings', 'phone-menu-settings')}
          {row('/about', faCircleInfo, 'About Gli', 'phone-menu-about')}
          {isModerator && (
            <>
              <hr className={RULE} />
              <a
                href={MODERATION_HREF}
                target="_blank"
                rel="noopener"
                data-attr="phone-menu-moderation"
                className={ROW}
              >
                <FontAwesomeIcon icon={faShieldHalved} aria-hidden="true" className={ICON} />
                Moderation
                <FontAwesomeIcon
                  icon={faArrowUpRightFromSquare}
                  aria-hidden="true"
                  className="ml-auto h-3 text-fg3"
                />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </>
          )}
        </nav>
        <hr className={RULE} />
        <div data-slot="phone-menu-theme" className="flex flex-col">
          <span
            aria-hidden="true"
            className="px-(--space-4) pt-(--space-2_5) pb-(--space-2) text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
          >
            Theme
          </span>
          <div className="px-(--space-4) pt-(--space-1) pb-(--space-3)">
            <ThemeMenu
              value={theme}
              onValueChange={onThemeChange}
              className="[&_[data-slot=toggle-group-item]]:h-8.5"
            />
          </div>
        </div>
        <hr className={RULE} />
        <button type="button" data-attr="phone-menu-sign-out" onClick={onSignOut} className={ROW}>
          <FontAwesomeIcon icon={faArrowRightFromBracket} aria-hidden="true" className={ICON} />
          Sign out
        </button>
      </DrawerContent>
    </Drawer>
  );
}
