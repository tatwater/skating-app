import { api } from '@skating/convex/api';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQuery } from 'convex/react';

import { useRole } from '@/lib/useRole';
import { useChromeStore } from '@/stores/chromeStore';

import { useThemeChoice } from '../AvatarMenu';
import { useChromeOverlay } from '../chrome';
import { SignOutDialog } from '../settings/SignOutGuard';
import { useGuardedSignOut } from '../settings/useGuardedSignOut';
import { PhoneMenuSheetView } from './PhoneMenuSheetView';

/**
 * The account sheet, wired (board 9.5): the avatar's overlay in the one-overlay chrome store, the
 * theme through the shared picker hook (the cookie, `theme_changed`), and Sign out through the same
 * draft guard as the desktop menu and Settings (board 7.15) — "Open the draft" reopens the sheet
 * over this page.
 */
export function PhoneMenuSheet({ container }: { container?: HTMLElement | null } = {}) {
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const profile = useQuery(api.profiles.current, {});
  const { isModerator } = useRole();
  const { theme, onThemeChange } = useThemeChoice();
  const guard = useGuardedSignOut();
  const { open, onOpenChange } = useChromeOverlay('avatar');

  return (
    <>
      <PhoneMenuSheetView
        open={open}
        onOpenChange={onOpenChange}
        person={{
          name: profile?.displayName ?? '',
          username: profile?.username ?? '',
          ...(profile?.profileImageUrl ? { imageUrl: profile.profileImageUrl } : {}),
        }}
        isModerator={isModerator}
        theme={theme}
        onThemeChange={onThemeChange}
        onNavigate={(href) => {
          // The sheet goes before the page changes, so it never slides out over the next one.
          useChromeStore.getState().setOverlay(null);
          router.history.push(href);
        }}
        onSignOut={() => {
          useChromeStore.getState().setOverlay(null);
          guard.request();
        }}
        {...(container !== undefined ? { container } : {})}
      />
      <SignOutDialog
        {...guard.dialog}
        onOpenDraft={(draft) => {
          guard.dialog.onOpenChange(false);
          const params = new URLSearchParams(location.searchStr);
          params.set('post', draft.post);
          router.history.push(`${location.pathname}?${params.toString()}`);
        }}
        {...(container !== undefined ? { container } : {})}
      />
    </>
  );
}
