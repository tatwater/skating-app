import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { hazardTypeLabel, relativeWhen, timingWindowLabel } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * Hazard identity, from the operator's side (N5c) — two lists that answer the same question at two
 * time scales.
 *
 * **The recurrence queue** is where an operator spends an hour in October and covers the whole corpus,
 * which is the difference between the feature existing and the feature working. Ranked across every
 * lake, bounded by construction — it reads the precomputed table and never touches `hazards` or
 * `waterBodies` in bulk (the Phase 7b rule).
 *
 * **The merges panel** is why auto-merge could ship at all. A mechanism that folds one safety pin into
 * another without a human, and leaves nowhere to look at what it did, is a mechanism nobody can check.
 * The bar it merges at is a guess until somebody watches it work — so every merge writes a row, they
 * are listed newest first, and Unmerge is one click. A rising unmerge rate means the bar is too low,
 * and the chart on `/admin/tuning` is where that shows up as a number.
 */
export const Route = createFileRoute('/admin/recurrence')({ component: AdminRecurrence });

/** Clusters per page. The queue's filters run per page, so this is a read bound, not a result count. */
const QUEUE_PAGE_SIZE = 50;

function AdminRecurrence() {
  const merges = useQuery(api.hazards.listRecentMerges, {});
  const unmerge = useMutation(api.hazards.unmerge);
  const [minSeasons, setMinSeasons] = useState(1);
  // A suppression is reversible by design (§7.3), which means it has to be reversible *from a
  // surface*. Hidden by default because the queue's job is what still needs deciding — but one
  // checkbox away, because a suppression nobody can find again is a delete with better paperwork.
  const [showSuppressed, setShowSuppressed] = useState(false);
  // `usePaginatedQuery` restarts the walk by itself when the args change, which is what a filter
  // change has to do: a cursor is a position in the *previous* filter's ranking.
  const {
    results: clusters,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.recurrence.listQueue,
    { minSeasons, includeSuppressed: showSuppressed },
    { initialNumItems: QUEUE_PAGE_SIZE },
  );
  const suppress = useMutation(api.recurrence.suppress);
  const unsuppress = useMutation(api.recurrence.unsuppress);

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title="Hazard identity"
        subtitle="What came back across winters, and what the app folded together within one. Neither list is a prediction — both are what was reported, and how often."
      />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-foreground text-lg">Before first ice</h2>
          <div className="flex flex-wrap items-center gap-4">
            {/* The bar an operator reads at, not the bar a skater sees. Thin patterns are on this
                page deliberately — that is the whole point of watching them form (D78). */}
            <label className="flex items-center gap-2 text-foreground-muted text-sm">
              Seen in at least
              <select
                className="rounded-md border border-border bg-surface px-2 py-1 text-foreground text-sm"
                value={minSeasons}
                onChange={(e) => setMinSeasons(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} winter{n === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-foreground-muted text-sm">
              <input
                type="checkbox"
                checked={showSuppressed}
                onChange={(e) => setShowSuppressed(e.target.checked)}
              />
              Show suppressed
            </label>
          </div>
        </div>
        {status === 'LoadingFirstPage' ? (
          <AdminEmpty>Loading…</AdminEmpty>
        ) : clusters.length === 0 && status === 'Exhausted' ? (
          <AdminEmpty>
            Nothing at that bar. A pattern needs the same spot reported in more than one winter, so
            an empty list this early is the corpus being young rather than anything being wrong.
          </AdminEmpty>
        ) : (
          clusters.map((cluster) => (
            <Card key={cluster._id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{cluster.family}</Badge>
                    <Link
                      to="/admin/water/$id"
                      params={{ id: cluster.waterBodyId }}
                      className="text-sm underline underline-offset-2"
                    >
                      {cluster.waterBodyName}
                    </Link>
                    {cluster.subAreaName ? (
                      <span className="text-foreground-muted text-sm">{cluster.subAreaName}</span>
                    ) : null}
                    {cluster.suppressedAt !== undefined ? (
                      <Badge variant="outline">Suppressed</Badge>
                    ) : null}
                  </div>
                  <p className="text-foreground-muted text-xs">
                    {/* Both numbers, on the operator surface too. */}
                    Seen in {cluster.seasonsObserved.length} of the last {cluster.windowSeasons}{' '}
                    winters ·{' '}
                    {timingWindowLabel(
                      cluster.firstReportedDayOfSeasonP25,
                      cluster.firstReportedDayOfSeasonP75,
                    ) ?? 'timing unclear'}{' '}
                    · {cluster.distinctAuthorCount} reporter
                    {cluster.distinctAuthorCount === 1 ? '' : 's'}
                  </p>
                  {cluster.suppressReason ? (
                    <p className="text-foreground-muted text-xs">
                      Suppressed — {cluster.suppressReason}
                    </p>
                  ) : null}
                </div>
                {cluster.suppressedAt !== undefined ? (
                  <ReasonDialog
                    trigger={
                      <Button variant="outline" size="sm">
                        Unsuppress
                      </Button>
                    }
                    title="Unsuppress this pattern"
                    description="It returns to the queue and regains the public bar. The original suppression and its reason stay in the audit log."
                    confirmLabel="Unsuppress"
                    onConfirm={(reason) =>
                      unsuppress({ recurrenceId: cluster._id, reason }).then(() => undefined)
                    }
                  />
                ) : (
                  <ReasonDialog
                    trigger={
                      <Button variant="outline" size="sm">
                        Suppress
                      </Button>
                    }
                    title="Suppress this pattern"
                    description="It stops being suggested and stops being publicly advisable, across every recompute. Reversible, and nothing is deleted."
                    confirmLabel="Suppress"
                    onConfirm={(reason) =>
                      suppress({ recurrenceId: cluster._id, reason }).then(() => undefined)
                    }
                  />
                )}
              </CardContent>
            </Card>
          ))
        )}
        {/* A page filtered down to nothing is how a filtered queue makes progress, so "more" is
            offered whenever the index has more — not when this page happened to come back full. */}
        {status === 'CanLoadMore' ? (
          <Button variant="outline" size="sm" onClick={() => loadMore(QUEUE_PAGE_SIZE)}>
            Load more
          </Button>
        ) : null}
      </section>

      <h2 className="font-semibold text-foreground text-lg">Recent automatic merges</h2>
      {merges === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : merges.length === 0 ? (
        <AdminEmpty>
          Nothing has been merged yet. Duplicates only collapse when their footprints genuinely
          overlap and share at least half their combined area.
        </AdminEmpty>
      ) : (
        merges.map((m) => (
          <Card key={m.actionId}>
            <CardContent className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={m.automatic ? 'secondary' : 'outline'}>
                    {m.automatic ? 'Automatic' : 'By a moderator'}
                  </Badge>
                  {m.action === 'unmerge_hazards' ? <Badge variant="outline">Undone</Badge> : null}
                  {m.type ? (
                    <span className="text-foreground text-sm">{hazardTypeLabel(m.type)}</span>
                  ) : null}
                  {m.waterBodyId ? (
                    <Link
                      to="/admin/water/$id"
                      params={{ id: m.waterBodyId }}
                      className="text-sm underline underline-offset-2"
                    >
                      {m.waterBodyName ?? 'this lake'}
                    </Link>
                  ) : null}
                </div>
                <p className="text-foreground-muted text-xs">
                  {relativeWhen(m.at, Date.now())}
                  {m.survivorId ? ' · folded into the earlier sighting' : ''}
                </p>
              </div>
              {/* Only what is *currently* merged can be pulled apart — an already-undone row is
                  history, and offering the button on it would be offering a no-op. */}
              {m.stillMerged ? (
                <ReasonDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      Unmerge
                    </Button>
                  }
                  title="Separate these pins"
                  description="Both pins return to the map intact, with their own footprints and their own confirm loops. They will not be merged again automatically."
                  confirmLabel="Unmerge"
                  onConfirm={(reason) =>
                    unmerge({ hazardId: m.loserId as Id<'hazards'>, reason }).then(() => undefined)
                  }
                />
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
