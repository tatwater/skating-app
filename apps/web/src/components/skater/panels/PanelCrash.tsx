import * as Sentry from '@sentry/tanstackstart-react';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect } from 'react';

import { isConfigured } from '@/lib/env';

import { Button } from '../../kit/button';
import { InsetCard, PanelColumn, PanelUnavailable } from './InsetCard';
import { useClosePanel } from './panelNavigation';

/**
 * A card's crash stays in the card (B03 §4.3): the map, the shell and the rest of Explore keep
 * running, the error goes to Sentry (once per mount, only with a DSN), and the card offers a retry.
 * The root's crash screen is the last resort, not the first.
 */
export function PanelCrash({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    if (isConfigured.sentry) Sentry.captureException(error);
  }, [error]);
  const close = useClosePanel(null);
  return (
    <PanelColumn>
      <InsetCard
        backTo="Explore"
        onClose={close}
        returnKey="panel:crash"
        label="Something broke"
        foot={
          <Button size="sm" data-attr="panel-retry" onClick={reset}>
            Try again
          </Button>
        }
      >
        <PanelUnavailable title="Something broke">
          This card couldn’t load. The map and the rest of the page still work.
        </PanelUnavailable>
      </InsetCard>
    </PanelColumn>
  );
}
