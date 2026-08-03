import { api } from '@skating/convex/api';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader, StatTile, Table, Td, Th } from '../components/admin/adminUi';
import { CatalogueCoverage } from '../components/admin/CatalogueCoverage';
import { ScalarTrend } from '../components/admin/MetricCharts';
import { useRole } from '../lib/useRole';

/**
 * Operator dashboard (D37) — queue depths at a glance, the app-health strip, and the recent-actions
 * audit feed. Queue depths are computed live off bounded indexes; the app-health trends read the daily
 * `metricSnapshots` rollups (admin-only, so a moderator sees everything else but not the strip).
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
  const { isAdmin } = useRole();
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

      {/* App-health strip (D37) — "how's it going" context every operator wants. Admin-only because it
          reads the metric rollups; a moderator sees the queues above but not the trends. */}
      {isAdmin ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
            App health · last 30 days
          </h2>
          <div className="grid gap-3 lg:grid-cols-3">
            <ScalarTrend
              title="Reports"
              description="Visible reports per day, by skate-end time."
              metrics={[{ key: 'reports_created', label: 'Reports' }]}
              height={160}
            />
            <ScalarTrend
              title="New accounts"
              description="Signups per day."
              metrics={[{ key: 'signups', label: 'Signups' }]}
              height={160}
            />
            <ScalarTrend
              title="Active contributors"
              description="Distinct authors posting in the trailing 7 days."
              metrics={[{ key: 'active_contributors', label: 'Contributors' }]}
              height={160}
            />
          </div>
        </section>
      ) : null}

      {/* The base map's own provenance (N7). Admin-only for the same reason as the health strip: it
          reads a metric snapshot. Sits below app health because it moves once a year, not once a day —
          it is the slowest number on this page and the one with the longest horizon. */}
      {isAdmin ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
            Base map · elevation-derived hydrography
          </h2>
          <CatalogueCoverage />
        </section>
      ) : null}

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
