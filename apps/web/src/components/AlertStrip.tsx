import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatAlertLine } from '@skating/core';
import { useQuery } from 'convex/react';

/**
 * The NWS advisory strip on a lake drawer (N6c B5, D74).
 *
 * **Visually distinct from our own content, and attributed.** Everything else in this drawer is
 * ours — our reports, our derived caption, our decay model. This is the National Weather Service
 * speaking, and a skater needs to be able to tell which is which at a glance, because the two carry
 * very different kinds of authority.
 *
 * **Top of the drawer**, above the weather-since strip and the forward forecast, because an official
 * warning outranks both an observation and a prediction. The ordering across the three strips is a
 * statement about authority rather than a layout preference.
 *
 * It renders nothing when there is no active alert — which is almost always, and is the point.
 */
export function AlertStrip({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const alerts = useQuery(api.weatherAlerts.listForBody, { waterBodyId });
  if (!alerts || alerts.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
      aria-label="National Weather Service alerts"
    >
      <h3 className="font-mono text-amber-700 text-xs uppercase tracking-widest dark:text-amber-400">
        Weather alerts
      </h3>
      <ul className="flex flex-col gap-1">
        {alerts.map((alert) => (
          <li key={alert.id} className="text-foreground text-sm">
            {formatAlertLine(alert)}
            {/* NWS's own headline, when they wrote one. Never paraphrased: the whole value of this
                strip is that the words are theirs. */}
            {alert.headline ? (
              <span className="block text-foreground-muted text-xs">{alert.headline}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-foreground-muted text-xs">
        Issued by the US National Weather Service. Alerts may cover a wider area than this lake.
      </p>
    </section>
  );
}
