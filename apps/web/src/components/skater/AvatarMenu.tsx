import { api } from '@skating/convex/api';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQuery } from 'convex/react';

import { useRole } from '@/lib/useRole';

import { useThemeChoice } from '../useThemeChoice';
import { AvatarMenuView } from './AvatarMenuView';
import { useChromeOverlay } from './chrome';
import { SignOutDialog } from './settings/SignOutGuard';
import { useGuardedSignOut } from './settings/useGuardedSignOut';

/**
 * Everything the account menu does, whichever skin draws it — the desktop avatar menu (board 3.24)
 * or the phone's sheet (board 9.5): the person, the role, the theme, the avatar overlay, and Sign
 * out through the draft guard (board 7.15), whose "Open the draft" reopens the sheet over this page.
 * Spread `menu` on the view and `signOutDialog` on `SignOutDialog`.
 */
export function useAccountMenu() {
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const profile = useQuery(api.profiles.current, {});
  const { isModerator } = useRole();
  const { theme, onThemeChange } = useThemeChoice();
  const guard = useGuardedSignOut();
  const { open, onOpenChange } = useChromeOverlay('avatar');
  return {
    menu: {
      open,
      onOpenChange,
      person: {
        name: profile?.displayName ?? '',
        username: profile?.username ?? '',
        ...(profile?.profileImageUrl ? { imageUrl: profile.profileImageUrl } : {}),
      },
      isModerator,
      theme,
      onThemeChange,
    },
    navigate: (href: string) => router.history.push(href),
    requestSignOut: guard.request,
    signOutDialog: {
      ...guard.dialog,
      onOpenDraft: (draft: { post: string }) => {
        guard.dialog.onOpenChange(false);
        const params = new URLSearchParams(location.searchStr);
        params.set('post', draft.post);
        router.history.push(`${location.pathname}?${params.toString()}`);
      },
    },
  };
}

/** The avatar's menu, wired (board 3.24): the desktop skin of `useAccountMenu`. */
export function AvatarMenu({ container }: { container?: HTMLElement | null } = {}) {
  const account = useAccountMenu();
  const scoped = container !== undefined ? { container } : {};
  return (
    <>
      <AvatarMenuView
        {...account.menu}
        onNavigate={account.navigate}
        onSignOut={account.requestSignOut}
        {...scoped}
      />
      <SignOutDialog {...account.signOutDialog} {...scoped} />
    </>
  );
}
