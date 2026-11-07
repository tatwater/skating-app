import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The shell's layout, props only: the top bar over the page in one grid, the page filling the rest
 * of the window and scrolling on its own (a map page fills it exactly and never scrolls). The
 * overlay slot is positioned against the page area — the offline plate sits a gap under the bar.
 *
 * **The breakpoint seam.** At `md` and up, the top bar. Below it, `phoneChrome` (the phone top bar
 * and tab bar, agent L) when given, otherwise the page full-bleed.
 */
export function SkaterFrame({
  topBar,
  phoneChrome,
  overlay,
  children,
  className,
}: {
  topBar: ReactNode;
  phoneChrome?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-surface="skater"
      data-slot="skater-shell"
      className={cn(
        'grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg font-(family-name:--family-sans) text-fg',
        className,
      )}
    >
      <div data-slot="skater-chrome" className="min-w-0">
        <div className="max-md:hidden">{topBar}</div>
        {phoneChrome !== undefined && <div className="md:hidden">{phoneChrome}</div>}
      </div>
      {/* The overlay is the page area's sibling, not its child, so it stays put while the page scrolls. */}
      <div className="relative min-h-0 min-w-0">
        <main data-slot="skater-page" className="h-full overflow-y-auto">
          {children}
        </main>
        {overlay}
      </div>
    </div>
  );
}
