import { useConvexConnectionState } from 'convex/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Whether the app can reach the server, for the offline states (B03 §1.6: boards 8.12, 8.13 and
 * 8.17). Two signals, because neither is enough alone:
 *
 * - **`navigator.onLine`** is the browser's word. `false` is reliable (no network at all), so it
 *   reads as offline at once. `true` only means *some* network: a captive portal or a dead backend
 *   still says `true`.
 * - **Convex's `connectionState()`** is the truth about our backend: whether the WebSocket is up,
 *   and whether it has *ever* been up this page load (`hasEverConnected`), which is what tells the
 *   first-load screen (8.12, the app never reached the server) from the plate over a page that was
 *   working a moment ago (8.13).
 *
 * The socket drops for ordinary reasons — a laptop lid, an auth refresh, a deploy — and reconnects
 * on its own within a few seconds, so a disconnect with the browser still online only counts as
 * offline after a grace period. A plate that flickers on every reconnect would teach people to
 * ignore it.
 *
 * **A disconnect is never an error.** Nothing here reports to Sentry: being offline is a state the
 * skater is in, not a fault in the app (§4.3), and the offline states render from this hook alone.
 */

/** A drop with the browser still online, before it reads as offline: the socket's usual reconnect. */
export const RECONNECT_GRACE_MS = 5_000;
/** The first load gets longer: Clerk and the socket are both still starting up. */
export const FIRST_LOAD_GRACE_MS = 10_000;
/** How often the offline screens stamp "Last tried" — the cadence their copy promises. */
export const RETRY_STAMP_MS = 30_000;

export type ConnectionStatus = 'online' | 'connecting' | 'offline';

export interface ConnectionInputs {
  browserOnline: boolean;
  socketConnected: boolean;
  hasEverConnected: boolean;
  /** How long the socket has been down (or, before the first connect, how long the page has waited). */
  downForMs: number;
}

/** The status the inputs add up to. Pure, so every edge has a test. */
export function connectionStatus({
  browserOnline,
  socketConnected,
  hasEverConnected,
  downForMs,
}: ConnectionInputs): ConnectionStatus {
  // A live socket is the strongest evidence there is; the browser's flag can lag it.
  if (socketConnected) return 'online';
  if (!browserOnline) return 'offline';
  const grace = hasEverConnected ? RECONNECT_GRACE_MS : FIRST_LOAD_GRACE_MS;
  return downForMs >= grace ? 'offline' : 'connecting';
}

export interface Connection {
  status: ConnectionStatus;
  /** True until the socket has opened once: an offline status then means the first-load screen. */
  firstLoad: boolean;
  /** When the connection was last known to be up — what "what's on screen is from" reads. */
  lastConnectedAt: number | null;
  /** When the offline screens last stamped a try (every {@link RETRY_STAMP_MS} while offline). */
  lastTriedAt: number | null;
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** The browser's online flag, live. The server has no network to speak of, so it renders online. */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * The connection, for the offline states. Must render under the Convex provider. The status starts
 * `connecting`, never `offline`, so the server render and the first client render agree and a page
 * that connects promptly never flashes an offline state.
 */
export function useConnection(): Connection {
  const browserOnline = useBrowserOnline();
  const { isWebSocketConnected, hasEverConnected } = useConvexConnectionState();

  // When the socket went down (or, before the first connect, when the page started waiting).
  const [downSince, setDownSince] = useState<number>(() => Date.now());
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const wasConnected = useRef(isWebSocketConnected);

  useEffect(() => {
    if (isWebSocketConnected) {
      wasConnected.current = true;
      setLastConnectedAt(Date.now());
      return;
    }
    if (wasConnected.current) {
      wasConnected.current = false;
      const at = Date.now();
      setDownSince(at);
      setNow(at);
      setLastConnectedAt(at);
    }
  }, [isWebSocketConnected]);

  const downForMs = isWebSocketConnected ? 0 : Math.max(0, now - downSince);
  const status = connectionStatus({
    browserOnline,
    socketConnected: isWebSocketConnected,
    hasEverConnected,
    downForMs,
  });

  // While the socket is down and the grace hasn't run out, wake once when it does.
  useEffect(() => {
    if (status !== 'connecting') return;
    const grace = hasEverConnected ? RECONNECT_GRACE_MS : FIRST_LOAD_GRACE_MS;
    const id = window.setTimeout(() => setNow(Date.now()), Math.max(0, grace - downForMs) + 1);
    return () => window.clearTimeout(id);
  }, [status, hasEverConnected, downForMs]);

  // Offline: stamp a try now and every thirty seconds, which is what "Last tried" shows. The Convex
  // client keeps retrying the socket on its own backoff underneath; this is the screen's cadence.
  const [lastTriedAt, setLastTriedAt] = useState<number | null>(null);
  useEffect(() => {
    if (status !== 'offline') {
      setLastTriedAt(null);
      return;
    }
    setLastTriedAt(Date.now());
    const id = window.setInterval(() => setLastTriedAt(Date.now()), RETRY_STAMP_MS);
    return () => window.clearInterval(id);
  }, [status]);

  return {
    status,
    firstLoad: !hasEverConnected,
    lastConnectedAt,
    lastTriedAt,
  };
}

/**
 * What "Try again" does. Convex exposes no reconnect, and its client retries on its own; the one
 * thing a press can add is a reload — but only when the browser says it has a network. Reloading
 * with none would swap the page the skater was on for the browser's own error page, which is the
 * opposite of "the page you were on stays".
 */
export function retryConnection(
  browserOnline: boolean,
  reload: () => void = () => window.location.reload(),
): boolean {
  if (!browserOnline) return false;
  reload();
  return true;
}
