import * as Sentry from '@sentry/tanstackstart-react';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect } from 'react';

import { isConfigured } from '@/lib/env';

import { Button } from '../../kit/button';

/**
 * Latest's crash stays on Latest (B03 §4.3): the shell and the top bar keep running, the error goes
 * to Sentry (once per mount, only with a DSN), and the page offers a retry. The root's crash screen
 * is the last resort, not the first.
 */
export function LatestCrash({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    if (isConfigured.sentry) Sentry.captureException(error);
  }, [error]);
  return (
    <div data-slot="skater-page" className="flex h-full justify-center px-(--space-10)">
      <div className="mt-(--space-7) flex h-fit w-[40rem] flex-col gap-(--space-3_5) border border-solid border-line2 px-(--space-7) py-(--space-6)">
        <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
          Latest
        </span>
        <p className="m-0 text-body leading-body text-fg">
          Latest couldn’t load. The map and the rest of the app still work.
        </p>
        <Button className="self-start" data-attr="latest-retry" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
