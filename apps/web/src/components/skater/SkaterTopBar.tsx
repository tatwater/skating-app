import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { useChromeStore } from '@/stores/chromeStore';

import { AvatarMenu } from './AvatarMenu';
import { activeTopLevel, withNewReport } from './chrome';
import { GlobalSearch } from './GlobalSearch';
import { NotificationsMenu } from './NotificationsMenu';
import { SkaterTopBarView } from './SkaterTopBarView';

/**
 * The skater top bar, wired: the lit link follows the route, New report opens the sheet over the
 * current page (`?post=new`, D242), and a navigation closes whichever overlay was open — the back
 * button included.
 */
export function SkaterTopBar() {
  const router = useRouter();
  const { capture } = useAnalytics();
  const location = useRouterState({ select: (s) => s.location });
  const { pathname, searchStr } = location;

  // A new page (not a new query on the same one) leaves no overlay hanging over it.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    useChromeStore.getState().setOverlay(null);
  }, [pathname]);

  return (
    <SkaterTopBarView
      active={activeTopLevel(pathname)}
      onNavigate={(href) => router.history.push(href)}
      onNewReport={() => {
        // The door records itself; the sheet doesn't know which door opened it.
        capture('report_sheet_opened', { entry: 'top_bar' });
        router.history.push(withNewReport(pathname, searchStr));
      }}
      search={<GlobalSearch />}
      notifications={<NotificationsMenu />}
      avatar={<AvatarMenu />}
    />
  );
}
