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
  const canTakedown = TAKEDOWNABLE.has(flag.targetType) && flag.target.exists;

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
          <span className="text-foreground-muted text-xs">
            flagged by {flag.flagger ? `@${flag.flagger.username}` : 'system'}
          </span>
        </div>
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

function AdminFlags() {
  const flags = useFlags();

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader title="Flag queue" subtitle="Safety flags first, then everything else." />
      {flags === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : flags.priority.length === 0 && flags.standard.length === 0 ? (
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
