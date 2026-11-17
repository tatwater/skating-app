import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRightFromBracket, faUser } from '@fortawesome/sharp-light-svg-icons';
import type { ThemePreference } from '@skating/design';
import type { ReactElement } from 'react';

import { PersonName, personNameClass } from '@/components/PersonName';
import { Avatar } from '@/components/kit/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { Skeleton, SkeletonText } from '@/components/kit/skeleton';
import { ThemePicker } from '@/components/kit/theme-picker';
import { ACCOUNT_WORDS } from '@/lib/account';
import { cn } from '@/lib/utils';

import { USER_MENU_WORDS } from './shellWords';

/**
 * The viewer's menu at the rail's foot (B01-2c), props only — the founder's request of 2026-11-16:
 * log out, change the theme, go to their own profile. No board draws it open; the boards put the
 * viewer's circle at the rail's foot, under the App item, and this is the plainest kit menu there.
 *
 * - **The trigger is the circle** the boards draw (26 px, the viewer tone), the whole rail wide so
 *   the menu opens at the rail's edge, as Legacy's does. It is named for what it opens ("Your
 *   account"); the circle is hidden from a reader, and the initials are masked from analytics.
 *   While the profile loads it keeps the circle's box (a skeleton), so the rail never shifts.
 * - **The head** names the viewer by their real name (`PersonName`) — never the handle, no role.
 * - **Your page in People** is the viewer's own person page in the console (board 8.6), by their
 *   profile id, in this tab: navigation inside the console, not a link out to the app. It lands on
 *   the person route itself, so a phone's stacked People opens on the person, never the list. Held
 *   back (disabled) until the profile is read; left out for a viewer who can't read People.
 * - **Theme** is the kit's picker over the shared preference — the same three choices, the same
 *   cookie, as the skater menu.
 * - **Sign out** is the last row, there in every state — a profile that never loads still lets the
 *   viewer leave.
 *
 * The kit menu brings the keyboard (Enter, Space or ↓ opens; ↑↓ walk the rows; Tab reaches the
 * theme's segments; Esc closes and gives focus back to the circle) and its layering.
 */

/** The viewer as the menu draws them: still loading, not readable, or read. */
export type MenuViewer =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; id: string; name: string; src?: string };

/** The viewer's own person page in the console's People. */
export function ownPageHref(id: string): string {
  return `/admin/people/${encodeURIComponent(id)}`;
}

export interface UserMenuViewProps {
  viewer: MenuViewer;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSignOut: () => void;
  /** The viewer may read People (`people.read`): without it, no row for their page. */
  canOpenOwnPage: boolean;
  /** The router's link for their page (`<Link to={to} />`); a plain anchor otherwise. */
  linkFor?: (to: string) => ReactElement;
  /** Controlled open state; uncontrolled without it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where the menu is portaled (a story's quad, so it takes that quad's theme). */
  container?: HTMLElement | null;
}

const ICON = 'h-[1em]';

export function UserMenuView({
  viewer,
  theme,
  onThemeChange,
  onSignOut,
  canOpenOwnPage,
  linkFor,
  open,
  onOpenChange,
  container,
}: UserMenuViewProps) {
  const ready = viewer.state === 'ready' ? viewer : null;
  const controlled = open !== undefined ? { open } : {};
  return (
    <DropdownMenu
      {...controlled}
      {...(onOpenChange !== undefined && { onOpenChange: (next: boolean) => onOpenChange(next) })}
      modal={false}
    >
      <DropdownMenuTrigger
        data-slot="user-menu-trigger"
        aria-label={ACCOUNT_WORDS.account}
        aria-busy={viewer.state === 'loading' ? true : undefined}
        className={cn(
          // The rail's width, the circle's height: the menu opens at the rail's edge.
          'group flex w-full cursor-pointer justify-center border-0 bg-transparent p-0 outline-none',
          personNameClass,
        )}
      >
        {ready !== null ? (
          <Avatar
            data-slot="user-menu-face"
            name={ready.name}
            {...(ready.src !== undefined ? { src: ready.src } : {})}
            size="lg"
            tone="viewer"
            aria-hidden="true"
            className={cn(
              'transition-colors duration-(--duration-fast) ease-standard',
              'group-hover:border-fg2 group-focus-visible:shadow-focus',
              'group-data-popup-open:border-fg',
            )}
          />
        ) : (
          <Skeleton
            data-slot="user-menu-face"
            className="size-avatar-lg rounded-full group-focus-visible:shadow-focus"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={container}
        side="right"
        align="end"
        sideOffset={0}
        aria-label={ACCOUNT_WORDS.account}
        className={cn('w-[15.5rem]', personNameClass)}
      >
        <MenuHead viewer={viewer} />
        {canOpenOwnPage && (
          <>
            <DropdownMenuItem
              data-slot="user-menu-own-page"
              icon={<FontAwesomeIcon icon={faUser} className={ICON} />}
              {...(ready !== null
                ? {
                    render:
                      linkFor?.(ownPageHref(ready.id)) ??
                      // biome-ignore lint/a11y/useAnchorContent: the item renders its label into it
                      <a href={ownPageHref(ready.id)} />,
                  }
                : { disabled: true })}
            >
              {USER_MENU_WORDS.ownPage}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{ACCOUNT_WORDS.theme}</DropdownMenuLabel>
          <div className="col-span-full px-(--space-3) pt-(--space-1) pb-(--space-2)">
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

/** Who is signed in: their circle and real name — or, until it's read, the reason it isn't there. */
function MenuHead({ viewer }: { viewer: MenuViewer }) {
  return (
    <div
      data-slot="user-menu-who"
      aria-busy={viewer.state === 'loading' ? true : undefined}
      className="col-span-full mb-(--space-1) flex items-center gap-(--space-2_5) border-0 border-b border-solid border-line px-[1.15em] pt-(--space-2) pb-(--space-2_5)"
    >
      {viewer.state === 'ready' ? (
        <>
          <Avatar
            name={viewer.name}
            {...(viewer.src !== undefined ? { src: viewer.src } : {})}
            size="md"
            aria-hidden="true"
          />
          <PersonName className="min-w-0 truncate text-row leading-list font-medium text-fg">
            {viewer.name}
          </PersonName>
        </>
      ) : viewer.state === 'loading' ? (
        <>
          <Skeleton className="size-avatar rounded-full" />
          <SkeletonText className="text-row leading-list" width="9rem" />
          <span className="sr-only">{USER_MENU_WORDS.loading}</span>
        </>
      ) : (
        <span className="text-row leading-list text-fg2">{USER_MENU_WORDS.failed}</span>
      )}
    </div>
  );
}
