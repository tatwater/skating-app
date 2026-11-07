import { useRouterState } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';

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
 * The auth gate's holding frame: the splash while the app starts, and the first-load offline
 * screen (8.12) once the socket has never opened and the grace has run out — without it, a first
 * load with no network sits on the splash forever.
 */
export function FirstLoadSplash() {
  return useMounted() ? <ConnectedFirstLoad /> : <Splash />;
}

function ConnectedFirstLoad() {
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
  return <Splash />;
}

/**
 * The plate over the page when the connection drops mid-session (8.13/8.17): centered over the map
 * on Explore (the sidebar is 27.5 rem), over the page elsewhere, a gap under the top bar.
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
        isMapRoute(pathname) ? 'left-[calc(27.5rem+(100%-27.5rem)/2)] max-md:left-1/2' : 'left-1/2',
      )}
    />
  );
}
