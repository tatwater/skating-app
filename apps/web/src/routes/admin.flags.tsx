import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * Flag queue (D37/D3) — the `unsafe_false_report` **priority lane** first (a dangerously false "ice is
 * great" claim is a safety incident, not FIFO spam), then everything else. Each row resolves its
 * subject so a moderator can triage in place: dismiss/action the flag, and (for content that carries a
 * moderation axis) hide/remove it — two separately-audited decisions.
 */
export const Route = createFileRoute('/admin/flags')({ component: AdminFlags });

// The three target types that carry a `moderationStatus` and can be taken down via setModerationStatus.
const TAKEDOWNABLE = new Set(['report', 'comment', 'hazard']);

type FlagView = NonNullable<ReturnType<typeof useFlags>>['priority'][number];
function useFlags() {
  return useQuery(api.moderation.listFlags, {});
}

function FlagRow({ flag }: { flag: FlagView }) {
  const resolveFlag = useMutation(api.moderation.resolveFlag);
  const setStatus = useMutation(api.moderation.setModerationStatus);
  const retractAlert = useMutation(api.accessAlerts.retract);
  const setAlertOfficial = useMutation(api.accessAlerts.setOfficial);
  const canTakedown = TAKEDOWNABLE.has(flag.targetType) && flag.target.exists;
  // An access alert has no `moderationStatus` to set — its takedown verb is **retraction** (D65
  // applied to access): "this was never true", which is exactly what a bogus "gate locked" is. So it
  // gets its own action rather than being the one flaggable thing a moderator cannot act on.
  //
  // **Pinning is the other half, and it was missing.** `retract` shipped wired and `setOfficial` did
  // not, so a moderator reaching a flagged alert could only ever conclude "this is false" — the
  // verdict the queue is shaped around. But a flag is also how a *true* alert reaches a moderator:
  // somebody who wants a lake to themselves flags a real "gate locked". Pinning it is the founder's
  // 2026-08-10 exemption from both the TTL and the seasonal reset, and without a button the only way
  // to act on a correct alert was to leave it and let it expire on schedule.
  const isAlert = flag.targetType === 'accessAlert' && flag.target.exists;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={flag.reason === 'unsafe_false_report' ? 'destructive' : 'secondary'}>
            {flag.reason}
          </Badge>
          <Badge variant="outline">{flag.targetType}</Badge>
          {flag.target.moderationStatus && flag.target.moderationStatus !== 'visible' ? (
            <Badge variant="outline">{flag.target.moderationStatus}</Badge>
          ) : null}
          {/* Bundled occurrence count (N2). One row per recurring problem, so this number is the
              thing a stream of identical rows was hiding — and it's the input to the D57 lever. */}
          {flag.occurrences > 1 ? (
            <Badge variant="outline">{ordinal(flag.occurrences)} occurrence</Badge>
          ) : null}
          <span className="text-foreground-muted text-xs">
            flagged by {flag.flagger ? `@${flag.flagger.username}` : 'system'}
          </span>
        </div>
        {flag.priorResolution && flag.priorResolvedAt ? (
          <p className="text-foreground-muted text-xs">
            Last {flag.priorResolution} {relativeDays(flag.priorResolvedAt)} — this is a recurrence
            of the same problem, filed fresh so the earlier disposition stays on the record.
          </p>
        ) : null}
        <p className="text-foreground text-sm">{flag.target.summary}</p>
        {flag.target.author ? (
          <p className="text-foreground-muted text-xs">
            by {flag.target.author.displayName} · @{flag.target.author.username}
          </p>
        ) : null}
        {flag.note ? <p className="text-foreground-muted text-sm italic">“{flag.note}”</p> : null}

        <div className="flex flex-wrap gap-2 pt-1">
          {canTakedown ? (
            <>
              <ReasonDialog
                trigger={
                  <Button variant="secondary" size="sm">
                    Hide content
                  </Button>
                }
                title={`Hide this ${flag.targetType}`}
                description="Hides it from the app and writes an audit record."
                confirmLabel="Hide"
                confirmVariant="secondary"
                onConfirm={(reason) =>
                  setStatus({
                    targetType: flag.targetType as 'report' | 'comment' | 'hazard',
                    targetId: flag.targetId,
                    status: 'hidden',
                    reason,
                  })
                }
              />
              <ReasonDialog
                trigger={
                  <Button variant="destructive" size="sm">
                    Remove content
                  </Button>
                }
                title={`Remove this ${flag.targetType}`}
                description="Removes it and writes an audit record."
                confirmLabel="Remove"
                onConfirm={(reason) =>
                  setStatus({
                    targetType: flag.targetType as 'report' | 'comment' | 'hazard',
                    targetId: flag.targetId,
                    status: 'removed',
                    reason,
                  })
                }
              />
            </>
          ) : null}
          {isAlert ? (
            <>
              <ReasonDialog
                trigger={
                  <Button variant="secondary" size="sm">
                    Retract alert
                  </Button>
                }
                title="Retract this access alert"
                description="Marks the claim as never having been true and writes an audit record. It stops annotating the launch immediately."
                confirmLabel="Retract"
                confirmVariant="secondary"
                onConfirm={(reason) =>
                  retractAlert({ accessAlertId: flag.targetId as Id<'accessAlerts'>, reason })
                }
              />
              <ReasonDialog
                trigger={
                  <Button variant="outline" size="sm">
                    Pin as official
                  </Button>
                }
                title="Pin this access alert as official"
                description="The alert stops expiring — no 30-day TTL and no seasonal reset — and carries your name. Use it when a flagged alert turns out to be true."
                confirmLabel="Pin"
                confirmVariant="default"
                onConfirm={(reason) =>
                  setAlertOfficial({
                    accessAlertId: flag.targetId as Id<'accessAlerts'>,
                    official: true,
                    reason,
                  })
                }
              />
            </>
          ) : null}
          <ReasonDialog
            trigger={
              <Button variant="outline" size="sm">
                Action flag
              </Button>
            }
            title="Mark this flag actioned"
            description="Records that you acted on the underlying content."
            confirmLabel="Actioned"
            confirmVariant="default"
            onConfirm={(reason) =>
              resolveFlag({ flagId: flag.id as Id<'contentFlags'>, resolution: 'actioned', reason })
            }
          />
          <ReasonDialog
            trigger={
              <Button variant="ghost" size="sm">
                Dismiss
              </Button>
            }
            title="Dismiss this flag"
            description="No violation found — records the decision."
            confirmLabel="Dismiss"
            confirmVariant="outline"
            onConfirm={(reason) =>
              resolveFlag({
                flagId: flag.id as Id<'contentFlags'>,
                resolution: 'dismissed',
                reason,
              })
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One lake's "no public access" reports, collapsed (N6f).
 *
 * **Grouped, unlike every other row on this page**, because it is the only claim many people can
 * independently make about the same target: five reports on one lake is one job whose count is the
 * signal, where five flags on one comment are five opinions to read. Ruling closes them all.
 */
function AccessReportRow({
  group,
}: {
  group: NonNullable<ReturnType<typeof useFlags>>['accessReports'][number];
}) {
  const setPublicAccess = useMutation(api.waterBodies.setPublicAccess);
  const waterBodyId = group.waterBodyId as Id<'waterBodies'>;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">no public access</Badge>
          {/* The corroboration count is the rank — this lane is sorted by it, not by age. */}
          <Badge variant="outline">
            {group.count} {group.count === 1 ? 'report' : 'reports'}
          </Badge>
          {group.disputesReviewFrom ? (
            <Badge variant="destructive">disputes a prior review</Badge>
          ) : null}
        </div>
        <p className="text-foreground text-sm">{group.name}</p>
        {group.disputesReviewFrom ? (
          <p className="text-foreground-muted text-xs">
            You ruled this open {relativeDays(group.disputesReviewFrom)}. These reports came after,
            and each had to say what changed.
          </p>
        ) : null}
        {group.notes.map((note) => (
          <p key={note} className="text-foreground-muted text-sm italic">
            “{note}”
          </p>
        ))}

        <div className="flex flex-wrap gap-2 pt-1">
          <ReasonDialog
            trigger={
              <Button variant="outline" size="sm">
                Mark no public access
              </Button>
            }
            title="Mark this body as having no public access"
            description="It stays on the map, drawn at half opacity and two zoom levels later, and every open report on it is closed as actioned."
            confirmLabel="Mark"
            confirmVariant="default"
            onConfirm={(reason) => setPublicAccess({ waterBodyId, verdict: 'none', reason })}
          />
          <ReasonDialog
            trigger={
              <Button variant="ghost" size="sm">
                Confirm public access
              </Button>
            }
            title="Confirm this body has public access"
            description="Nothing changes on the map. The reports are dismissed, and reporting it again will require saying what changed."
            confirmLabel="Confirm"
            confirmVariant="outline"
            onConfirm={(reason) => setPublicAccess({ waterBodyId, verdict: 'open', reason })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function AdminFlags() {
  const flags = useFlags();

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader title="Flag queue" subtitle="Safety flags first, then everything else." />
      {flags === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : flags.priority.length === 0 &&
        flags.standard.length === 0 &&
        flags.accessReports.length === 0 ? (
        <AdminEmpty>The queue is clear. 🎉</AdminEmpty>
      ) : (
        <>
          {flags.priority.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-mono text-destructive text-xs uppercase tracking-widest">
                Priority · safety
              </h2>
              {flags.priority.map((f) => (
                <FlagRow key={f.id} flag={f} />
              ))}
            </section>
          ) : null}
          {flags.accessReports.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
                Access · most corroborated first
              </h2>
              {flags.accessReports.map((g) => (
                <AccessReportRow key={g.waterBodyId} group={g} />
              ))}
            </section>
          ) : null}
          {flags.standard.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
                Standard
              </h2>
              {flags.standard.map((f) => (
                <FlagRow key={f.id} flag={f} />
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** "4th", "2nd" — small enough that a table isn't worth it. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** "6d ago" / "today" — the resolution recency a moderator judges a recurrence against. */
function relativeDays(at: number): string {
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  return `${days}d ago`;
}
