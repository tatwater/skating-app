import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTriangleExclamation } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatAlertLine, type NwsAlert } from '@skating/core';
import { useQuery } from 'convex/react';

import { Note } from '@/components/kit/note';

/** The strip's last line: who is speaking, and how wide their area is. */
export const NWS_FOOT =
  'Issued by the US National Weather Service. Alerts cover a wider area than this lake.';

/**
 * The NWS alerts on a lake (board 1.12), **above the tabs** — a warning from the forecast office
 * outranks both our observations and anybody's forecast, and a tabbed alert is one you can be a tab
 * away from not seeing (A06c §2.5). Amber, attributed, and in the Weather Service's own words: the
 * headline is theirs, never paraphrased. Renders nothing when there's no active alert — almost
 * always, and that is the point.
 */
export function AlertStripView({ alerts }: { alerts: readonly NwsAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <section
      aria-label="National Weather Service alerts"
      data-slot="lake-alerts"
      className="border-0 border-b border-solid border-line px-gutter py-(--space-4)"
    >
      <Note tone="warn" className="flex flex-col gap-(--space-2) text-fg1">
        <span className="flex items-center gap-(--space-2) text-kick font-semibold tracking-kick text-warn uppercase">
          <FontAwesomeIcon icon={faTriangleExclamation} aria-hidden="true" className="h-[1.1em]" />
          Weather alerts
        </span>
        <ul className="m-0 flex list-none flex-col gap-(--space-2) p-0">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex flex-col gap-(--space-1)">
              <strong>{formatAlertLine(alert)}</strong>
              {alert.headline ? (
                <span className="text-assist text-fg1 [text-wrap:pretty]">{alert.headline}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <span className="text-assist text-fg2">{NWS_FOOT}</span>
      </Note>
    </section>
  );
}

export function AlertStrip({ waterBodyId }: { waterBodyId: string }) {
  const alerts = useQuery(api.weatherAlerts.listForBody, {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
  });
  return <AlertStripView alerts={alerts ?? []} />;
}
