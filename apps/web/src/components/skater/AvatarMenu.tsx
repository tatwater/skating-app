import { api } from '@skating/convex/api';
import type { ThemePreference } from '@skating/design';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useCallback } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { useRole } from '@/lib/useRole';

import { useTheme } from '../theme-provider';
import { AvatarMenuView } from './AvatarMenuView';
import { useChromeOverlay } from './chrome';
import { SignOutDialog } from './settings/SignOutGuard';
import { useGuardedSignOut } from './settings/useGuardedSignOut';

/**
 * The theme choice as the pickers use it: `useTheme()`'s preference, and a setter that writes the
 * cookie (D241) and records `theme_changed` — only for a real change, never for re-pressing the
 * chosen option. Shared by the avatar menu and (later) the phone's menu sheet.
 */
export function useThemeChoice(): {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
} {
  const { theme, setTheme } = useTheme();
  const { capture } = useAnalytics();
  const onThemeChange = useCallback(
    (next: ThemePreference) => {
      if (next === theme) return;
      setTheme(next);
      capture('theme_changed', { mode: next });
    },
    [theme, setTheme, capture],
  );
  return { theme, onThemeChange };
}

/**
 * The avatar's menu, wired (board 3.24). Sign out asks first when an unsent draft would go with it
 * (board 7.15), the same guard Settings uses; "Open the draft" reopens the sheet over this page.
 */
export function AvatarMenu({ container }: { container?: HTMLElement | null } = {}) {
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const profile = useQuery(api.profiles.current, {});
  const { isModerator } = useRole();
  const { theme, onThemeChange } = useThemeChoice();
  const guard = useGuardedSignOut();
  const { open, onOpenChange } = useChromeOverlay('avatar');

  return (
    <>
      <AvatarMenuView
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
        onNavigate={(href) => router.history.push(href)}
        onSignOut={guard.request}
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
