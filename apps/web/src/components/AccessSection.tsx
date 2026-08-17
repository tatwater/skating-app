import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { chooseAccessTarget, describeApproach, isHikeIn } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { AccessPhotos } from './AccessPhotos';
import { Panel } from './Panel';
import { PostedAccessLine } from './PostedAccess';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

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
  const createAlert = useMutation(api.accessAlerts.create);

  if (!access) return null;
  return (
    <AccessSectionView
      access={access}
      onVote={(accessAlertId, verdict) =>
        vote({ accessAlertId: accessAlertId as Id<'accessAlerts'>, verdict })
      }
      onCreateAlert={(putInId, reason, note) =>
        createAlert({
          targetType: 'put_in',
          putInId: putInId as Id<'putIns'>,
          reason: reason as 'gate_locked',
          ...(note ? { note } : {}),
        })
      }
    />
  );
}

/**
 * What `accessForBody` hands back — taken from the function's own return type rather than restated.
 *
 * Restating it is the version that rots: the query grows a field, this shape does not, and the view
 * silently stops seeing it. The same reason the enums are re-exported from core instead of re-typed.
 */
export type AccessData = FunctionReturnType<typeof api.accessPoints.accessForBody>;

/**
 * The rendering half, split out so it can be tested without a Convex client — the `HazardListView`
 * pattern, and for the same reason: everything worth asserting here is a rule about what appears on
 * screen, and none of it is a rule about how the data arrived.
 */
export function AccessSectionView({
  access,
  onVote,
  onCreateAlert,
}: {
  access: AccessData;
  // Opaque string ids, matching `chooseAccessTarget`'s own signature: the resolver is shared with
  // mobile and deliberately knows nothing about Convex's branded types. The data half below is the
  // one place that knows which table each id belongs to, so that is where the cast lives.
  onVote: (accessAlertId: string, verdict: 'still_blocked' | 'open') => Promise<unknown>;
  onCreateAlert: (putInId: string, reason: string, note?: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('gate_locked');
  const [note, setNote] = useState('');

  if (access.putIns.length === 0 && access.parking.length === 0) return null;

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

      {/* Rules posted on *these* access points (N6e), against the point each governs. The body's own
          rule is a separate strip above this panel and is never folded in here: a lot shut during a
          shop's business hours says nothing about the launch beside it, or about the ice. */}
      {target ? (
        <>
          <PostedAccessLine rule={target.putIn.postedAccess} coord={target.putIn.coord} />
          {target.parking ? (
            <PostedAccessLine rule={target.parking.postedAccess} coord={target.parking.coord} />
          ) : null}
        </>
      ) : null}

      {access.parking.some((p) => p.amenities.length > 0) ? (
        <p className="text-foreground-muted text-xs">
          {[
            ...new Set(
              access.parking.flatMap((p) => p.amenities.map((a) => AMENITY_LABELS[a] ?? a)),
            ),
          ].join(' · ')}
        </p>
      ) : null}

      {/* The drive time and the walk are NEVER summed (D72 amendment, ramification 2). A 55-minute
          drive plus a 25-minute walk is not an 80-minute drive, and folding one into the other would
          corrupt the filter a skater is actually using. They are two lines for that reason. */}

      {/* "Is this the right dirt road?" — the founder's rationale, and the reason these hang off the
          access point rather than a report: a parking lot looks the same next November, so they are
          infrastructure and exempt from the seasonal purge (D66 carve-out). */}
      {target ? (
        <div className="mt-3">
          <AccessPhotos
            putInId={target.putIn.id as Id<'putIns'>}
            label={`Photos — ${target.putIn.name ?? 'the launch'}`}
          />
        </div>
      ) : null}

      {/* The entry point for D73's lifecycle. Below the access description, because reporting a
          blocked gate is something you do *after* reading where you'd have gone. */}
      {target ? (
        reporting ? (
          <div className="mt-2 space-y-2">
            <select
              className="w-full rounded border p-1 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="What's the problem?"
            >
              {Object.entries(REASON_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything else worth knowing (optional)"
              rows={2}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy === 'new'}
                onClick={async () => {
                  setBusy('new');
                  try {
                    await onCreateAlert(target.putIn.id, reason, note.trim() || undefined);
                    setReporting(false);
                    setNote('');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Post
              </Button>
              <Button size="sm" variant="outline" onClick={() => setReporting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setReporting(true)}>
            Report an access problem
          </Button>
        )
      ) : null}

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
                        await onVote(alert.id, 'still_blocked');
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
                        await onVote(alert.id, 'open');
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
