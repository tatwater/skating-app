import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  describeStanding,
  formatAreaAcres,
  type RequestKind,
  requestKindTitle,
  waterBodyClassLabel,
} from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Button, buttonVariants } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * The request queue (A07b PR 2 / D107) — **a skater asked; a moderator answers.**
 *
 * One card per open request, **oldest first, whatever the kind** — a request nobody answered is the
 * worst row, and grouping by kind would bury an old restore under every new tap.
 * Each card shows what a decision needs and nothing it doesn't: who asked and what they wrote, the
 * lake and its standing (or, for an `admit`, what the catalog found under the point — name, class,
 * acres, and the service URL to eyeball the outline), and how many *other* people have the same
 * open ask on the same lake, which is the rank.
 *
 * Approving performs the act through the verb the lake editor uses — activate, restore, remove,
 * confirm access, admit — and closes every sibling ask with it. Declining takes a note the skater
 * reads. Both are one dialog, so a moderator clearing a queue of forty does not learn a second UI.
 */
export const Route = createFileRoute('/admin/water/requests')({ component: RequestQueue });

function messageOf(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data.message ?? 'Something went wrong.');
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function RequestQueue() {
  const [status, setStatus] = useState<'open' | 'approved' | 'declined'>('open');
  const rows = useQuery(api.corpusRequests.listQueue, { status });
  const count = useQuery(api.corpusRequests.queueCount, {});
  const approve = useMutation(api.corpusRequests.approve);
  const decline = useMutation(api.corpusRequests.decline);
  const reresolve = useMutation(api.corpusRequests.reresolve);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Requests"
        subtitle={`Skaters asking for lakes — ${count ? `${count.count}${count.capped ? '+' : ''} open` : '…'}.`}
      />

      <div className="flex flex-wrap gap-2">
        {(['open', 'approved', 'declined'] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === status ? 'default' : 'outline'}
            onClick={() => setStatus(s)}
          >
            {s[0]?.toUpperCase()}
            {s.slice(1)}
          </Button>
        ))}
      </div>

      {banner ? (
        <p
          className={
            banner.tone === 'ok' ? 'text-foreground-muted text-sm' : 'text-destructive text-sm'
          }
        >
          {banner.text}
        </p>
      ) : null}

      {rows === undefined ? null : rows.length === 0 ? (
        <AdminEmpty>
          {status === 'open' ? 'Nothing waiting — every ask has an answer.' : 'Nothing here yet.'}
        </AdminEmpty>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <Card key={row._id}>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-foreground">
                    {requestKindTitle(row.kind)}
                    {/* The bay a `name_bay` asks for — the question itself (D201). */}
                    {row.name ? <span className="ml-2">— {row.name}</span> : null}
                    {/* A capped count is a floor, shown even at "1+" — the queue is a backlog and
                        the rest of this lake's askers may sit past the page (Greptile, PR #63). */}
                    {row.askers > 1 || row.askersCapped ? (
                      <span
                        className="ml-2 font-mono text-foreground-muted text-xs"
                        title={
                          row.askersCapped
                            ? 'The queue is past its page; more may have asked for this lake.'
                            : undefined
                        }
                      >
                        {row.askers}
                        {row.askersCapped ? '+' : ''} people
                      </span>
                    ) : null}
                  </p>
                  <p className="font-mono text-foreground-muted text-xs">
                    {new Date(row.createdAt).toLocaleDateString()} · {row.requester.displayName}
                  </p>
                </div>

                {row.body ? (
                  <p className="text-sm">
                    <Link
                      to="/admin/water/$id"
                      params={{ id: row.body._id }}
                      className="underline underline-offset-2"
                    >
                      {row.body.name || '(unnamed)'}
                    </Link>
                    <span className="ml-2 text-foreground-muted">
                      {waterBodyClassLabel(row.body.type)} · {row.body.states.join(' ')} ·{' '}
                      {formatAreaAcres(row.body.surfaceAreaSqM)}
                    </span>
                    <span className="ml-2 text-foreground-muted">
                      — {describeStanding(row.body.standing) ?? 'active'}
                    </span>
                  </p>
                ) : row.candidate ? (
                  <p className="text-sm">
                    <span className="text-foreground">
                      {row.candidate.name || '(unnamed in the catalog)'}
                    </span>
                    <span className="ml-2 text-foreground-muted">
                      {row.candidate.cls
                        ? waterBodyClassLabel(row.candidate.cls)
                        : `3DHP feature type ${row.candidate.featureType} — not a class we hold`}{' '}
                      · {formatAreaAcres(row.candidate.surfaceAreaSqM)} · 3DHP{' '}
                      {row.candidate.externalId}
                    </span>{' '}
                    <a
                      href={row.candidate.serviceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      outline ↗
                    </a>
                  </p>
                ) : (
                  <p className="text-foreground-muted text-sm">
                    {row.resolveError
                      ? `Catalog lookup: ${row.resolveError}`
                      : 'Waiting for the catalog lookup…'}
                    <span className="ml-2 font-mono text-xs">
                      {row.coord.lat.toFixed(4)}, {row.coord.lng.toFixed(4)}
                    </span>
                  </p>
                )}

                {row.note ? (
                  <blockquote className="border-border border-l-2 pl-3 text-foreground-muted text-sm">
                    {row.note}
                  </blockquote>
                ) : null}
                {row.activityId ? (
                  <p className="text-foreground-muted text-xs">
                    Backed by a recorded skate over this water.
                  </p>
                ) : null}

                {row.status === 'open' ? (
                  <div className="flex flex-wrap gap-2">
                    {/* A bay is drawn, not approved: until a sub-area by that name exists on the
                        lake the only act is the drawing, in the lake editor's chord tool, which
                        approves the ask itself. Approve here is for a bay already drawn. */}
                    {row.kind === 'name_bay' && row.body && !row.drawnSubAreaId ? (
                      <Link
                        to="/admin/water/$id"
                        params={{ id: row.body._id }}
                        className={buttonVariants({ size: 'sm' })}
                      >
                        Draw it in the lake editor
                      </Link>
                    ) : null}
                    <ReasonDialog
                      trigger={
                        <Button
                          size="sm"
                          variant={
                            row.kind === 'name_bay' && !row.drawnSubAreaId ? 'outline' : 'default'
                          }
                          disabled={
                            (row.kind === 'admit' && !row.candidate) ||
                            (row.kind === 'name_bay' && !row.drawnSubAreaId)
                          }
                        >
                          Approve
                        </Button>
                      }
                      title={`Approve — ${requestKindTitle(row.kind).toLowerCase()}`}
                      description={approveDescription(row.kind)}
                      confirmLabel="Approve"
                      requireReason={false}
                      reasonPlaceholder="Optional note the skater will read"
                      onConfirm={async (note) => {
                        try {
                          await approve({
                            requestId: row._id as Id<'waterBodyRequests'>,
                            ...(note ? { note } : {}),
                          });
                          setBanner({ tone: 'ok', text: 'Approved.' });
                        } catch (err) {
                          setBanner({ tone: 'error', text: messageOf(err) });
                          throw err;
                        }
                      }}
                    />
                    <ReasonDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          Decline
                        </Button>
                      }
                      title="Decline this request"
                      description="The skater reads your note on the lake. Declining keeps the record — a lake four people asked for stays a lake four people asked for."
                      confirmLabel="Decline"
                      confirmVariant="secondary"
                      requireReason={true}
                      reasonPlaceholder="Why not — what they can do instead"
                      onConfirm={async (note) => {
                        try {
                          await decline({
                            requestId: row._id as Id<'waterBodyRequests'>,
                            note,
                          });
                          setBanner({ tone: 'ok', text: 'Declined.' });
                        } catch (err) {
                          setBanner({ tone: 'error', text: messageOf(err) });
                          throw err;
                        }
                      }}
                    />
                    {row.kind === 'admit' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await reresolve({ requestId: row._id as Id<'waterBodyRequests'> });
                            setBanner({ tone: 'ok', text: 'Asked the catalog again.' });
                          } catch (err) {
                            setBanner({ tone: 'error', text: messageOf(err) });
                          }
                        }}
                      >
                        Look up again
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-foreground-muted text-xs">
                    {row.status === 'approved' ? 'Approved' : 'Declined'}
                    {row.decidedAt ? ` ${new Date(row.decidedAt).toLocaleDateString()}` : ''}
                    {row.decisionNote ? ` — ${row.decisionNote}` : ''}
                    {row.admittedWaterBodyId ? (
                      <>
                        {' · '}
                        <Link
                          to="/admin/water/$id"
                          params={{ id: row.admittedWaterBodyId }}
                          className="underline underline-offset-2"
                        >
                          the admitted body
                        </Link>
                      </>
                    ) : null}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function approveDescription(kind: RequestKind): string {
  switch (kind) {
    case 'activate':
      return 'Brings the lake back to the active map — re-scored, re-registered for weather, on every push surface. Every other open ask for it is approved with this one.';
    case 'admit':
      return 'Inserts the catalog’s outline as a body kept by request, active from now. Admin-visible provenance: the 3DHP id and the service URL.';
    case 'restore':
      return 'Reverses the removal (admin). The lake comes back active unless a no-access ruling still stands.';
    case 'contest_access':
      return 'Sets the access ruling to “open” with your note, which brings the lake back to the active map and closes the reports that led to the ruling.';
    case 'takedown':
      return 'Removes the lake at the landowner’s request (admin). It stays reachable when zoomed in, with the reason; it leaves search and every push surface.';
    case 'name_bay':
      return 'Records that the bay drawn on this lake answers the ask. Every other open ask for the same bay is approved with it; the skater reads that a moderator drew it.';
  }
}
