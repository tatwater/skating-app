import { useChromeStore } from '@/stores/chromeStore';

import { useAccountMenu } from '../AvatarMenu';
import { SignOutDialog } from '../settings/SignOutGuard';
import { PhoneMenuSheetView } from './PhoneMenuSheetView';

/**
 * The account sheet, wired (board 9.5): the phone skin of `useAccountMenu` — the same person,
 * role, theme and draft-guarded Sign out as the desktop menu. The one difference is the sheet's:
 * it closes before the page changes, so it never slides out over the next one.
 */
export function PhoneMenuSheet({ container }: { container?: HTMLElement | null } = {}) {
  const account = useAccountMenu();
  const scoped = container !== undefined ? { container } : {};
  const closeSheet = () => useChromeStore.getState().setOverlay(null);
  return (
    <>
      <PhoneMenuSheetView
        {...account.menu}
        onNavigate={(href) => {
          closeSheet();
          account.navigate(href);
        }}
        onSignOut={() => {
          closeSheet();
          account.requestSignOut();
        }}
        {...scoped}
      />
      <SignOutDialog {...account.signOutDialog} {...scoped} />
    </>
  );
}
