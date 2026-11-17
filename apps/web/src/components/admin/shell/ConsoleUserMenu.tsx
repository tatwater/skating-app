import type { ReactElement } from 'react';

import { useThemeChoice } from '@/components/useThemeChoice';
import { SignOutDialog, type UnsentDraft } from '@/components/skater/settings/SignOutGuard';
import { useGuardedSignOut } from '@/components/skater/settings/useGuardedSignOut';

import { type MenuViewer, UserMenuView } from './UserMenuView';

/** Where "Open the draft" takes the viewer: the app, its report sheet open on the draft. */
export function draftHref(draft: Pick<UnsentDraft, 'post'>): string {
  return `/?${new URLSearchParams({ post: draft.post }).toString()}`;
}

/**
 * The viewer's menu, wired (B01-2c): their own page in People (same tab, through the router), the theme through the one shared choice (`useThemeChoice` —
 * the skater menu's cookie, its `theme_changed`), and Sign out the skater menu's way — through the
 * draft guard (`useGuardedSignOut`, then Clerk), so a report this browser still holds unsent from
 * the app is never discarded without asking. Its "Open the draft" opens the app in a new tab on that
 * draft (the console never opens the report sheet over itself), and the console stays signed in.
 *
 * Where Sign out lands is Clerk's and the gate's, as in the app: Clerk ends the session, the
 * console's role read empties, and `AuthGate` holds every path — `/admin` ones included — on the
 * splash and sends it to `/sign-in`, so Back never draws a console page again.
 */
export function ConsoleUserMenu({
  viewer,
  canOpenOwnPage,
  linkFor,
}: {
  viewer: MenuViewer;
  /** The viewer may read People: their own page is a row. */
  canOpenOwnPage: boolean;
  /** The router's link, as the rail's. */
  linkFor?: (to: string) => ReactElement;
}) {
  const { theme, onThemeChange } = useThemeChoice();
  const guard = useGuardedSignOut();
  return (
    <>
      <UserMenuView
        viewer={viewer}
        theme={theme}
        onThemeChange={onThemeChange}
        onSignOut={guard.request}
        canOpenOwnPage={canOpenOwnPage}
        {...(linkFor !== undefined && { linkFor })}
      />
      <SignOutDialog
        {...guard.dialog}
        onOpenDraft={(draft) => {
          guard.dialog.onOpenChange(false);
          window.open(draftHref(draft), '_blank', 'noopener');
        }}
      />
    </>
  );
}
