import { useEffect, useRef, useState } from 'react';

import type { Colleague } from '@/components/kit/top-bar-parts';

/**
 * Colleague presence (the top bar's faces): this tab says it is in the console, and reads who else
 * is. The server keeps one row per staff member and writes at most once a minute
 * (`console.heartbeat`); the read is `console.colleagues`.
 */

/** How often an open, visible console tab says so: the server's own interval. */
export const HEARTBEAT_MS = 60_000;

/**
 * Sends `send` while `enabled` and the tab is visible: at once on mount or on coming back into view,
 * then once a minute — never sooner than a minute after the last, however the tab flickers between
 * hidden and visible — and not at all while the tab is hidden. A failed send is dropped: the next
 * beat is the retry, and presence is never worth an error on the page.
 */
export function useHeartbeat(enabled: boolean, send: () => unknown): void {
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!enabled) return;
    let last = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      last = Date.now();
      try {
        const sent = sendRef.current();
        if (sent instanceof Promise) sent.catch(() => {});
      } catch {
        // Dropped: the next beat is the retry.
      }
      timer = setTimeout(tick, HEARTBEAT_MS);
    };
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (document.visibilityState !== 'visible') return;
      timer = setTimeout(tick, Math.max(0, last + HEARTBEAT_MS - Date.now()));
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}

/** The instant the console reads presence and the tape against, moved on once a minute. */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** `console.colleagues`' rows as the top bar's faces. */
export function colleaguesFrom(
  rows: ReadonlyArray<{ id: string; name: string; src: string | null; present: boolean }>,
): Colleague[] {
  return rows.map(({ src, ...rest }) => ({ ...rest, ...(src !== null ? { src } : {}) }));
}
