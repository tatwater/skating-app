import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import type { ReactNode } from 'react';
import { ThemeToggle } from './theme-toggle';
import { Button } from './ui/button';

/**
 * Chrome for the signed-in app: the two co-primary top-level pages (Map · Newsfeed, D28)
 * plus profile / settings / sign-out and the theme toggle. Report + Bounties are folded
 * into the pages themselves (D47), so they're not nav items. Rendered only in the `app`
 * zone (see `AuthGate`).
 */
const navLinkClass =
  'rounded-md px-3 py-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground';
const navActiveClass = 'rounded-md px-3 py-1.5 bg-surface-muted text-foreground';

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const profile = useQuery(api.profiles.current, {});

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-10 flex items-center gap-6 border-border border-b bg-surface px-4 py-3">
        <Link
          to="/"
          className="font-bold font-mono text-foreground text-sm uppercase tracking-widest"
        >
          Skating
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
            Newsfeed
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <ThemeToggle />
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
      <main className="mx-auto w-full max-w-6xl flex-1 p-4">{children}</main>
    </div>
  );
}
