import { api } from '@skating/convex/api';
import type { Doc, Id } from '@skating/convex/dataModel';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader, StatTile } from '../components/admin/adminUi';
import { formatDuration, ImportRunDetail, StatusBadge } from '../components/admin/ImportRunDetail';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';

/**
 * ETL run history (N6c Workstream F2) — **admin-only**, because a run row names deployment targets,
 * source URLs and file checksums.
 *
 * Every loader under `scripts/` used to compute a genuinely useful summary and print it to a
 * terminal that scrolls, so "how did the last import go", "is coverage better than last time" and
 * "which features did it decline" had no answer short of re-running the pass. This page is that
 * answer, and the per-run view carries the **whole path** — extract, filter, transform, load — so a
 * body on the map traces back to a file with a checksum.
 */
export const Route = createFileRoute('/admin/imports')({
  component: AdminImports,
  validateSearch: (search: Record<string, unknown>) => ({
    run: typeof search.run === 'string' ? search.run : undefined,
  }),
});

function AdminImports() {
  const { run: selectedId } = Route.useSearch();
  const navigate = useNavigate({ from: '/admin/imports' });
  const runs = useQuery(api.importRuns.list, { limit: 50 });
  const selected = useQuery(
    api.importRuns.get,
    selectedId ? { runId: selectedId as Id<'importRuns'> } : 'skip',
  );

  if (selectedId && selected !== undefined) {
    return (
      <div className="flex flex-col gap-4">
        <AdminPageHeader
          title="Import run"
          subtitle="The full path this data took, from the archived source file to the rows on the map."
          actions={
            <button
              type="button"
              className="text-foreground-muted text-sm underline"
              onClick={() => navigate({ search: { run: undefined } })}
            >
              ← All runs
            </button>
          }
        />
        {selected === null ? (
          <AdminEmpty>That run no longer exists.</AdminEmpty>
        ) : (
          <ImportRunDetail run={selected} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title="Imports"
        subtitle="Every ETL run, with what it wrote and what it declined. Newest first."
      />
      {runs === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : runs.length === 0 ? (
        <AdminEmpty>No import runs recorded yet.</AdminEmpty>
      ) : (
        <>
          <LatestCampaign runs={runs} />
          <div className="flex flex-col gap-2">
            {runs.map((run) => (
              <RunRow
                key={run._id}
                run={run}
                onOpen={() => navigate({ search: { run: run._id } })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The most recent campaign, totalled.
 *
 * **Grouped rather than listed** because five state extracts are five loader invocations and one
 * canonical update — "how did the last import go" is a question about the update. A campaign that
 * contains even one failed or still-`running` row is not shown as clean, however good the totals
 * look: a partial import that reads as complete is the single most expensive way to be wrong here.
 */
function LatestCampaign({ runs }: { runs: Doc<'importRuns'>[] }) {
  const campaignId = runs.find((r) => r.campaignId !== undefined)?.campaignId;
  if (campaignId === undefined) return null;
  const members = runs.filter((r) => r.campaignId === campaignId);

  const total = (name: string) =>
    members.reduce((sum, r) => sum + (r.counts.find((c) => c.name === name)?.value ?? 0), 0);
  const failures = members.reduce((sum, r) => sum + r.failuresTotal, 0);
  const unfinished = members.filter((r) => r.status !== 'succeeded').length;
  const started = Math.min(...members.map((r) => r.startedAt));
  const finished = members.every((r) => r.finishedAt !== undefined)
    ? Math.max(...members.map((r) => r.finishedAt ?? 0))
    : undefined;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium text-foreground">Latest campaign</h2>
        <Badge variant="outline">{campaignId}</Badge>
        <span className="text-foreground-muted text-sm">
          {members.length} run{members.length === 1 ? '' : 's'}
          {finished === undefined ? ' · in progress' : ` · ${formatDuration(finished - started)}`}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Inserted" value={total('inserted').toLocaleString()} />
        <StatTile label="Updated" value={total('updated').toLocaleString()} />
        <StatTile
          label="Failures"
          value={failures.toLocaleString()}
          tone={failures > 0 ? 'warning' : 'default'}
          hint={failures > 0 ? 'itemized on each run' : undefined}
        />
        <StatTile
          label="Runs not clean"
          value={unfinished.toLocaleString()}
          tone={unfinished > 0 ? 'danger' : 'default'}
          hint={unfinished > 0 ? 'failed or never finished' : 'all succeeded'}
        />
      </div>
    </section>
  );
}

function RunRow({ run, onOpen }: { run: Doc<'importRuns'>; onOpen: () => void }) {
  const inserted = run.counts.find((c) => c.name === 'inserted')?.value;
  const updated = run.counts.find((c) => c.name === 'updated')?.value;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <span className="font-medium text-foreground text-sm">{run.label}</span>
            <Badge variant="outline">{run.kind}</Badge>
            {run.isProd ? <Badge variant="destructive">production</Badge> : null}
          </div>
          <span className="text-foreground-muted text-xs">
            {new Date(run.startedAt).toLocaleString()}
            {run.finishedAt !== undefined
              ? ` · ${formatDuration(run.finishedAt - run.startedAt)}`
              : ' · no finish recorded'}
            {inserted !== undefined ? ` · ${inserted.toLocaleString()} inserted` : ''}
            {updated !== undefined ? ` · ${updated.toLocaleString()} updated` : ''}
            {run.failuresTotal > 0 ? ` · ${run.failuresTotal.toLocaleString()} failed` : ''}
          </span>
        </div>
        <button type="button" className="text-foreground text-sm underline" onClick={onOpen}>
          View path
        </button>
      </CardContent>
    </Card>
  );
}
