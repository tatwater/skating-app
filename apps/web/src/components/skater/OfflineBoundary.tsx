import { useRouterState } from '@tanstack/react-router';
import { type ReactNode, useSyncExternalStore } from 'react';

import { isMapRoute } from '@/lib/mapSelection';
import { retryConnection, useBrowserOnline, useConnection } from '@/lib/useConnection';
import { cn } from '@/lib/utils';

import { Splash } from '../Splash';
import { OfflinePlate, OfflineScreen } from './OfflineScreen';

/**
 * Where the offline states mount. Both read the connection only once mounted on the client: the
 * server has no socket to ask, and the first client render must match the server's.
 */

const noop = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * The escalation every gate hold needs: `children` while the app starts, and the first-load offline
 * screen (8.12) once the socket has never opened and the grace has run out — without it, a first
 * load with no network sits on the hold forever, whatever that hold looks like.
 *
 * Shared rather than baked into the splash, because the hold is a splash only on a cold start: from
 * the second load of a browser session it is `BootScreen` (`lib/boot.ts`), and a skeleton that never
 * becomes the offline screen is a page that silently never loads.
 */
export function FirstLoadHold({ children }: { children: ReactNode }) {
  if (!useMounted()) return children;
  return <ConnectedFirstLoad>{children}</ConnectedFirstLoad>;
}

/** The auth gate's cold-start hold: the splash, and the offline screen if the socket never opens. */
export function FirstLoadSplash() {
  return (
    <FirstLoadHold>
      <Splash />
    </FirstLoadHold>
  );
}

function ConnectedFirstLoad({ children }: { children: ReactNode }) {
  const connection = useConnection();
  const browserOnline = useBrowserOnline();
  if (connection.status === 'offline' && connection.firstLoad) {
    return (
      <OfflineScreen
        lastTriedAt={connection.lastTriedAt}
        onRetry={() => retryConnection(browserOnline)}
      />
    );
  }
  return children;
}

/**
 * The plate over the page when the connection drops mid-session (8.13/8.17): centered over the map
 * on Explore (past the sidebar), over the page elsewhere, a gap under the top bar.
 */
export function OfflineOverPage() {
  return useMounted() ? <ConnectedOverPage /> : null;
}

function ConnectedOverPage() {
  const connection = useConnection();
  const browserOnline = useBrowserOnline();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (connection.status !== 'offline' || connection.firstLoad) return null;
  return (
    <OfflinePlate
      since={connection.lastConnectedAt}
      onRetry={() => retryConnection(browserOnline)}
      className={cn(
        'absolute top-(--space-4) z-(--z-raised) -translate-x-1/2',
        isMapRoute(pathname)
          ? 'left-[calc(var(--size-sidebar)+(100%-var(--size-sidebar))/2)] max-md:left-1/2'
          : 'left-1/2',
      )}
    />
  );
}
