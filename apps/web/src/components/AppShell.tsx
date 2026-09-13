import { useAuth } from '@clerk/tanstack-react-start';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBell } from '@fortawesome/sharp-regular-svg-icons';
import { api } from '@skating/convex/api';
import { deviceTimeZone, timezoneToSync } from '@skating/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { type ReactNode, useEffect } from 'react';
import logoBlack from '../assets/gli-black-duotone.svg';
import logoWhite from '../assets/gli-white-duotone.svg';
import { isMapRoute } from '../lib/mapSelection';
import { LakeSearch } from './LakeSearch';
import { ThemeToggle } from './theme-toggle';
import { Button } from './ui/button';

/**
 * Chrome for the signed-in app: the two co-primary top-level pages (Map · Latest, D28; renamed from
 * Newsfeed by N6h/D159)
 * plus profile / settings / sign-out and the theme toggle. Report + Bounties are folded
 * into the pages themselves (D47), so they're not nav items. Rendered only in the `app`
 * zone (see `AuthGate`).
 *
 * ## The map route gets a different shell
 *
 * Every other page is a document: it scrolls, and it's centred in a readable column. The map is an
 * *application surface* — it should be as large as the window allows, and the window should not
 * scroll, because scrolling a page that contains a map is how you end up dragging the page when you
 * meant to pan. So on a map route the shell locks to the viewport height and hands the whole
 * remainder to the route, which splits it into map + sidebar (see the `_map` layout).
 *
 * The lake search rides here rather than in the map layout for the same reason: with the map filling
 * its column there is nowhere above it to put a search box, and the header has an empty middle. It
 * renders only on the map routes, since selecting a result opens a lake *on the map* — offering it
 * on `/settings` would be an invitation to leave the page you're in the middle of.
 */
const navLinkClass =
  'rounded-md px-3 py-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground';
const navActiveClass = 'rounded-md px-3 py-1.5 bg-surface-muted text-foreground';

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const profile = useQuery(api.profiles.current, {});
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The bell's dot (N8/A3). `unreadCount` is a capped indexed read, so subscribing to it from the
  // shell — every page — is one small query, not a scan.
  const unread = useQuery(api.notifications.unreadCount, profile ? {} : 'skip') ?? 0;

  // The 8pm digest's zone (N8/C): the device's, refreshed on app open, written only when it differs.
  // The shell is the one component every signed-in page renders, which makes it "app open".
  const setTimezone = useMutation(api.profiles.setTimezone);
  const hasProfile = !!profile;
  const storedZone = profile?.timezone;
  useEffect(() => {
    if (!hasProfile) return;
    const timezone = timezoneToSync(storedZone, deviceTimeZone());
    if (timezone !== null) void setTimezone({ timezone }).catch(() => {});
  }, [hasProfile, storedZone, setTimezone]);
  const mapRoute = isMapRoute(pathname);

  return (
    <div
      className={`flex flex-col bg-background ${mapRoute ? 'h-screen overflow-hidden' : 'min-h-screen'}`}
    >
      <header className="sticky top-0 z-30 flex shrink-0 items-center gap-6 border-border border-b bg-surface px-4 py-3">
        {/* Both marks ship and CSS picks one. Swapping on `resolvedTheme` would mean rendering
            nothing (or the wrong mark) until hydration — the same first-paint problem `ThemeToggle`
            works around — whereas the `dark:` variant resolves at paint from the class already on
            <html>. The inert mark is `display:none`, so screen readers announce the alt text once. */}
        <Link to="/" className="flex shrink-0 items-center">
          <img src={logoBlack} alt="Gli" className="h-7 w-auto dark:hidden" />
          <img src={logoWhite} alt="Gli" className="hidden h-7 w-auto dark:block" />
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className={navLinkClass}
            activeProps={{ className: navActiveClass }}
          >
            Map
          </Link>
          <Link to="/feed" className={navLinkClass} activeProps={{ className: navActiveClass }}>
            Latest
          </Link>
          {profile?.role === 'moderator' || profile?.role === 'admin' ? (
            <Link to="/admin" className={navLinkClass} activeProps={{ className: navActiveClass }}>
              Admin
            </Link>
          ) : null}
        </nav>
        {/* The search fills the gap between the nav and the account controls — on map routes it's
            the search box, everywhere else it's the space that keeps those controls to the right. */}
        <div className="min-w-0 flex-1">{mapRoute ? <LakeSearch /> : null}</div>
        <div className="flex shrink-0 items-center gap-2 text-sm">
          <ThemeToggle />
          <Link
            to="/notifications"
            className="relative rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
            activeProps={{
              className: 'relative rounded-md p-1.5 bg-surface-muted text-foreground',
            }}
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          >
            <FontAwesomeIcon icon={faBell} className="size-4" />
            {unread > 0 ? (
              <span
                aria-hidden
                className="absolute top-1 right-1 size-2 rounded-full bg-primary ring-2 ring-surface"
              />
            ) : null}
          </Link>
          {profile ? (
            <Link
              to="/u/$username"
              params={{ username: profile.username }}
              className="text-foreground-muted hover:text-foreground"
            >
              @{profile.username}
            </Link>
          ) : null}
          <Link to="/settings" className="text-foreground-muted hover:text-foreground">
            Settings
          </Link>
          <Button variant="outline" size="sm" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      <main
        className={
          mapRoute ? 'flex min-h-0 w-full flex-1 flex-col' : 'mx-auto w-full max-w-6xl flex-1 p-4'
        }
      >
        {children}
      </main>
    </div>
  );
}
