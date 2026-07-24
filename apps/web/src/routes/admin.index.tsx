import { api } from '@skating/convex/api';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader, StatTile, Table, Td, Th } from '../components/admin/adminUi';

/**
 * Operator dashboard (D37) — queue depths at a glance + the recent-actions audit feed. The app-health
 * strip and tuning charts land with the analytics commit (they need the `metricSnapshots` rollups);
 * everything here is computable live off bounded indexes.
 */
export const Route = createFileRoute('/admin/')({ component: AdminDashboard });

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function AdminDashboard() {
  const flags = useQuery(api.moderation.listFlags, {});
  const pending = useQuery(api.waterBodies.listPendingReview, {});
  const dedup = useQuery(api.waterBodies.listDedupCandidates, {});
  const actions = useQuery(api.moderation.listActions, { limit: 20 });

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader title="Dashboard" subtitle="Work queues + recent moderator actions." />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Safety flags"
          value={flags ? flags.priority.length : '—'}
          hint="unsafe_false_report — priority lane"
          tone={flags && flags.priority.length > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="Other flags"
          value={flags ? flags.standard.length : '—'}
          hint="spam / harassment / etc."
        />
        <StatTile
          label="Bodies to review"
          value={pending ? pending.length : '—'}
          hint="pending user-drawn bodies"
        />
        <StatTile
          label="Dedup candidates"
          value={dedup ? dedup.length : '—'}
          hint="suspected duplicates"
        />
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link to="/admin/flags" className="text-primary hover:underline">
          Go to flag queue →
        </Link>
        <Link to="/admin/water" className="text-primary hover:underline">
          Review water bodies →
        </Link>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Recent actions
        </h2>
        {actions === undefined ? (
          <AdminEmpty>Loading…</AdminEmpty>
        ) : actions.length === 0 ? (
          <AdminEmpty>No moderator actions yet.</AdminEmpty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-foreground-muted">
                    {timeAgo(a.createdAt)}
                  </Td>
                  <Td className="whitespace-nowrap">{a.actor ? `@${a.actor.username}` : '—'}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs">{a.action}</Td>
                  <Td className="text-foreground-muted">{a.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
