/**
 * Story support: a Body console tab in the inspector's column, at the board's size — 380 px wide,
 * the 692 px under the tab grid and over the status bar (boards 5.4.2–5.4.5, 1440 × 900), with the
 * pane's 20 px gutters — so a story can be set beside the board's right column and read the same.
 * Story-only; nothing in the app imports it. The frame builder's pane replaces it in the console.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** The inspector pane's height under the tab grid on a 900 px board: 870 − 178. */
const BOARD_PANE_HEIGHT = 'h-[43.25rem]';

export function InspectorFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="inspector-frame"
      className={cn(
        'relative flex w-(--size-inspector) flex-col overflow-y-auto border-0 border-l border-solid border-line bg-bg px-(--space-5)',
        'font-(family-name:--family-sans) text-fg',
        BOARD_PANE_HEIGHT,
        className,
      )}
    >
      {children}
    </div>
  );
}
