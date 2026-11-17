import type { UnsavedChannel } from '@/lib/unsavedElsewhere';

/**
 * One browser's tabs, in memory: every channel but the sender hears a post, as `BroadcastChannel`
 * does. Hand `make` to `setUnsavedChannelForTests`; `open` is what is still listening.
 */
export function tabsHub() {
  const open = new Set<{ heard: Set<(m: unknown) => void> }>();
  const make = (): UnsavedChannel => {
    const me = { heard: new Set<(m: unknown) => void>() };
    open.add(me);
    return {
      post: (m) => {
        for (const other of open) if (other !== me) for (const fn of other.heard) fn(m);
      },
      listen: (fn) => {
        me.heard.add(fn);
        return () => me.heard.delete(fn);
      },
      close: () => {
        open.delete(me);
      },
    };
  };
  return { make, open };
}
