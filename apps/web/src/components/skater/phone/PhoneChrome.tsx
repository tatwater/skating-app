import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { useChromeStore } from '@/stores/chromeStore';

import { activeTopLevel, withNewReport } from '../chrome';
import { GlobalSearch } from '../GlobalSearch';
import { NotificationsMenu } from '../NotificationsMenu';
import { reportSheetLinkState } from '../sheet/sheetHostModel';
import { PhoneMenuSheet } from './PhoneMenuSheet';
import { PhoneSearchView } from './PhoneSearchView';
import { PhoneTabBarView } from './PhoneTabBarView';
import { PhoneTopBarView } from './PhoneTopBarView';

/**
 * The phone's chrome, wired (row 9): the short top bar (logo · search · bell · you) and the tab bar
 * (Explore · New report · Latest), in the shell's `phoneChrome` slot below `md`.
 *
 * `live` is the shell's breakpoint answer. The bars draw either way (CSS shows them only below
 * `md`, so the first paint is right before hydration knows the width), but the overlays — search,
 * the bell, the account sheet — mount only while live: they're controlled by the one chrome store,
 * and a second copy of each, mounted beside the desktop bar's, would open with it.
 */
export function PhoneChrome({ live }: { live: boolean }) {
  const router = useRouter();
  const { capture } = useAnalytics();
  const location = useRouterState({ select: (s) => s.location });
  const { pathname, searchStr } = location;

  // A new page (not a new query on the same one) leaves no overlay hanging over it — the desktop
  // bar's rule, kept while it's the phone bar that's mounted.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    if (live) useChromeStore.getState().setOverlay(null);
  }, [pathname, live]);

  const go = (href: string) => router.history.push(href);
  return (
    <>
      <PhoneTopBarView
        onNavigate={go}
        search={
          live ? (
            <GlobalSearch layout="phone" />
          ) : (
            <PhoneSearchView
              open={false}
              onOpenChange={() => {}}
              query=""
              onQueryChange={() => {}}
              groups={[]}
              onPick={() => {}}
            />
          )
        }
        notifications={live ? <NotificationsMenu /> : null}
        avatar={live ? <PhoneMenuSheet /> : null}
      />
      <PhoneTabBarView
        active={activeTopLevel(pathname)}
        onNavigate={go}
        onNewReport={() => {
          // The door records itself, and says so in the state so the sheet's host doesn't count it again.
          capture('report_sheet_opened', { entry: 'phone_tab' });
          router.history.push(withNewReport(pathname, searchStr), reportSheetLinkState());
        }}
      />
    </>
  );
}
