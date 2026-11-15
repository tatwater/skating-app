import type { ReactNode } from 'react';

import { ReadBoundary } from '@/components/kit/read-boundary';
import { RetryNote } from '@/components/kit/retry-note';

/**
 * **The one boundary around a Body console tab.** A crash inside a tab (a read's answer it couldn't
 * draw, a bug) is caught here, reported to Sentry, and said in the tab's place with *Try again*,
 * which draws the tab again — never the console's crash screen. Another body or another tab starts
 * clean. A failed *read* is not a crash: each read says so in its own block (`ReadNote`).
 */
export function TabBoundary({
  bodyId,
  tab,
  label,
  children,
}: {
  bodyId: string;
  tab: string;
  /** The tab's name, for the note ("Hazards couldn’t be shown"). */
  label: string;
  children: ReactNode;
}) {
  return (
    <ReadBoundary
      resetKey={`${bodyId}:${tab}`}
      fallback={(retry) => (
        <RetryNote data-for="body-tab" data-slot="tab-failed" onRetry={retry}>
          {label} couldn’t be shown
        </RetryNote>
      )}
    >
      {children}
    </ReadBoundary>
  );
}
