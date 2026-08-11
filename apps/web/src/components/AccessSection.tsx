import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { chooseAccessTarget, describeApproach, isHikeIn } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Panel } from './Panel';
import { Button } from './ui/button';

/** How each alert reason reads to a skater. Short, because it sits beside a launch name. */
const REASON_LABELS: Record<string, string> = {
  road_closed: 'Road closed',
  gate_locked: 'Gate locked',
  not_plowed: 'Not plowed',
  lot_full: 'Lot full',
  private_no_access: 'Private — no access',
  other: 'Access problem',
};

const AMENITY_LABELS: Record<string, string> = {
  toilets: 'Toilets',
  trail: 'Trail',
  boat_ramp: 'Boat ramp',
};

/**
 * How you get onto this lake (N6d / D72, D73, D87).
 *
 * Renders **nothing at all** when there is no access data, which is most of the corpus. That is the
 * N6c B4 discipline applied here: a section that says "we don't know where to park" on 20,000 lakes is
 * worse than no section, and the honest signal is its absence.
 *
 * ## What the alert strip is careful about
 *
 * An alert **annotates and never suppresses** (open question 3). The blocked launch stays on screen,
 * stays nameable, and stays routable — it simply sorts below an open one for directions and carries a
 * warning. A lake with three launches and one locked gate is still a lake worth telling someone about,
 * which is the same never-hide invariant hazards hold, for the same reason.
 */
export function AccessSection({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const vote = useMutation(api.accessAlerts.vote);
  const [busy, setBusy] = useState<string | null>(null);

  if (!access || (access.putIns.length === 0 && access.parking.length === 0)) return null;

  const target = chooseAccessTarget(access.putIns, access.parking, new Set(access.blockedIds));
  const approach = target ? describeApproach(target) : null;
  const alerts = access.alerts ?? [];

  const nameFor = (alert: (typeof alerts)[number]) => {
    if (alert.putInId) {
      return access.putIns.find((p) => p.id === alert.putInId)?.name ?? 'a launch';
    }
    return access.parking.find((p) => p.id === alert.parkingAreaId)?.name ?? 'the parking area';
  };

  return (
    <Panel title="Getting there">
      {target ? (
        <p className="text-sm">
          {target.via === 'parking'
            ? `Park at ${target.parking?.name ?? 'the lot'}, then put in at ${target.putIn.name ?? 'the shore'}.`
            : `Put in at ${target.putIn.name ?? 'the shore'}.`}
          {/* The chip is derived, never entered — `approachKind === 'hike_in'`, with an operator
              override for the cases where the number lies. The whole point is that nobody should
              discover this at the trailhead. */}
          {isHikeIn(target.approachKind) ? (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 text-xs">
              Hike-in
            </span>
          ) : null}
        </p>
      ) : null}

      {/* "about" vs "at least" is decided in core: a straight-line fallback under-reports, and the
          hedge is the difference between an estimate and a floor (D87). */}
      {approach ? <p className="text-foreground-muted text-sm">{approach}</p> : null}

      {access.parking.some((p) => p.amenities.length > 0) ? (
        <p className="text-foreground-muted text-xs">
          {[
            ...new Set(access.parking.flatMap((p) => p.amenities.map((a) => AMENITY_LABELS[a] ?? a))),
          ].join(' · ')}
        </p>
      ) : null}

      {/* The drive time and the walk are NEVER summed (D72 amendment, ramification 2). A 55-minute
          drive plus a 25-minute walk is not an 80-minute drive, and folding one into the other would
          corrupt the filter a skater is actually using. They are two lines for that reason. */}

      {alerts.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {alerts.map((alert) => (
            <li key={alert.id} className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">
              <p className="font-medium">
                {REASON_LABELS[alert.reason] ?? 'Access problem'} — {nameFor(alert)}
                {alert.official ? (
                  <span className="ml-2 text-amber-900 text-xs">confirmed by a moderator</span>
                ) : null}
              </p>
              {alert.note ? <p className="text-foreground-muted">{alert.note}</p> : null}
              {alert.official ? null : (
                <div className="mt-1 flex gap-2">
                  {/* Confirming resets the clock; denying twice resolves it. The asymmetry hazards
                      have is deliberately absent — being wrong about a gate costs a drive either way. */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === alert.id}
                    onClick={async () => {
                      setBusy(alert.id);
                      try {
                        await vote({ accessAlertId: alert.id, verdict: 'still_blocked' });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Still blocked
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === alert.id}
                    onClick={async () => {
                      setBusy(alert.id);
                      try {
                        await vote({ accessAlertId: alert.id, verdict: 'open' });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    It's open
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
