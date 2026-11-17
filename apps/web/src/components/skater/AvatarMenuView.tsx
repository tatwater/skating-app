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

import { ACCOUNT_WORDS, profileHref } from '@/lib/account';
import { cn } from '@/lib/utils';

import { Avatar } from '../kit/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../kit/dropdown-menu';
import { ThemePicker } from '../kit/theme-picker';
import { navLinkProps } from './chrome';

/**
 * The avatar's menu (board 3.24), props only: who you are, then everything that isn't a
 * destination of its own — your profile, Settings, About — Moderation for moderators (the console,
 * in a **new tab**: the standing rule), the theme, and Sign out.
 *
 * The theme row is a kit ToggleGroup inside the menu: ↓ reaches the menu's rows, Tab reaches the
 * segments, ←→ move between them.
 */
export interface AvatarMenuPerson {
  name: string;
  username: string;
  imageUrl?: string;
}

export interface AvatarMenuViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: AvatarMenuPerson;
  /** Holds a moderator or admin role: the Moderation row. */
  isModerator: boolean;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onNavigate: (href: string) => void;
  onSignOut: () => void;
  container?: HTMLElement | null;
}

export const MODERATION_HREF = '/admin';

const ICON = 'h-[1em]';

export function AvatarMenuView({
  open,
  onOpenChange,
  person,
  isModerator,
  theme,
  onThemeChange,
  onNavigate,
  onSignOut,
  container,
}: AvatarMenuViewProps) {
  // Enter on a row and a plain press both arrive as a click; a modified press opens a tab.
  const go = (href: string) => navLinkProps(href, onNavigate);
  const profile = profileHref(person.username);
  return (
    <DropdownMenu open={open} onOpenChange={(next) => onOpenChange(next)} modal={false}>
      <DropdownMenuTrigger
        data-attr="avatar"
        aria-label={ACCOUNT_WORDS.account}
        // Initials are a person's: never autocaptured (D240).
        className={cn(
          'ph-no-capture ml-(--space-1_5) inline-flex shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 outline-none',
          'focus-visible:shadow-focus',
        )}
      >
        <Avatar
          name={person.name}
          {...(person.imageUrl ? { src: person.imageUrl } : {})}
          size="lg"
          tone="viewer"
          aria-hidden="true"
          className={cn(open && 'border-fg')}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={container}
        align="end"
        sideOffset={8}
        className="ph-no-capture w-[15.5rem] text-row"
      >
        <div
          data-slot="avatar-menu-who"
          className="col-span-full mb-(--space-1_5) flex items-center gap-(--space-3) border-0 border-b border-solid border-line px-(--space-4) pt-(--space-3) pb-(--space-3_5)"
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
            <span className="truncate font-(family-name:--family-mono) text-mono-sm leading-(--lead-snug) font-regular text-fg2">
              @{person.username}
            </span>
          </span>
        </div>
        <DropdownMenuItem
          icon={<FontAwesomeIcon icon={faUser} className={ICON} />}
          render={<a {...go(profile)} />}
        >
          {ACCOUNT_WORDS.profile}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<FontAwesomeIcon icon={faGear} className={ICON} />}
          render={<a {...go('/settings')} />}
        >
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<FontAwesomeIcon icon={faCircleInfo} className={ICON} />}
          render={<a {...go('/about')} />}
        >
          About Gli
        </DropdownMenuItem>
        {isModerator && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              label="Moderation"
              icon={<FontAwesomeIcon icon={faShieldHalved} className={ICON} />}
              render={<a href={MODERATION_HREF} target="_blank" rel="noopener" />}
            >
              <span className="flex items-center justify-between gap-(--space-3)">
                Moderation
                <FontAwesomeIcon
                  icon={faArrowUpRightFromSquare}
                  aria-hidden="true"
                  className="h-[0.8em] text-fg3"
                />
                <span className="sr-only">{ACCOUNT_WORDS.newTab}</span>
              </span>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{ACCOUNT_WORDS.theme}</DropdownMenuLabel>
          <div className="col-span-full px-(--space-4) pt-(--space-1_5) pb-(--space-2_5)">
            <ThemePicker value={theme} onValueChange={onThemeChange} />
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<FontAwesomeIcon icon={faArrowRightFromBracket} className={ICON} />}
          onClick={onSignOut}
        >
          {ACCOUNT_WORDS.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
