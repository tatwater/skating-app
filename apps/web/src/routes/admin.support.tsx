import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

/**
 * Support inbox (D35/D37) — **admin-only** (PII). Tickets, bug reports, and account appeals
 * (`category: account`), filterable by status, with assign/resolve. Server-gated to admins.
 */
export const Route = createFileRoute('/admin/support')({ component: AdminSupport });

const STATUSES = ['open', 'in_progress', 'resolved'] as const;

function AdminSupport() {
  const [status, setStatus] = useState<'all' | (typeof STATUSES)[number]>('open');
  const tickets = useQuery(api.support.list, status === 'all' ? {} : { status });
  const assign = useMutation(api.support.assign);
  const resolve = useMutation(api.support.resolve);

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title="Support"
        subtitle="Tickets, bug reports, and account appeals."
        actions={
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {tickets === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : tickets.length === 0 ? (
        <AdminEmpty>
          No tickets{status !== 'all' ? ` that are ${status.replace('_', ' ')}` : ''}.
        </AdminEmpty>
      ) : (
        tickets.map((t) => (
          <Card key={t.id}>
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={t.category === 'safety' ? 'destructive' : 'outline'}>
                  {t.category}
                </Badge>
                <Badge variant="secondary">{t.status.replace('_', ' ')}</Badge>
                <span className="text-foreground-muted text-xs">
                  {t.submitter ? `@${t.submitter.username}` : 'anonymous'}
                </span>
                {t.assignedTo ? (
                  <span className="text-foreground-muted text-xs">→ @{t.assignedTo.username}</span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-foreground text-sm">{t.body}</p>
              {t.context ? (
                <p className="font-mono text-foreground-muted text-xs">
                  {[t.context.platform, t.context.appVersion, t.context.deviceModel]
                    .filter(Boolean)
                    .join(' · ')}
                  {t.context.sentryEventId ? ` · sentry:${t.context.sentryEventId}` : ''}
                </p>
              ) : null}
              {t.status !== 'resolved' ? (
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => assign({ ticketId: t.id as Id<'supportTickets'> })}
                  >
                    Assign to me
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => resolve({ ticketId: t.id as Id<'supportTickets'> })}
                  >
                    Resolve
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
