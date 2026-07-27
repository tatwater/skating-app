import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { searchQueryArg } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader, Table, Td, Th } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';

/**
 * Water-body review (D37) + dedup merge (D36) + the **curation list** (N2), and a search that routes
 * into the per-lake editor.
 *
 * The two queues are unchanged. What's new is the third section, which exists because nothing in the
 * app previously answered "which bodies have I curated?": `curatedBoost` was editable per body with
 * no index and no list, so the five Phase-2.5 seed mis-matches — four Champlain bays whose boost
 * landed on same-named lakes elsewhere — were invisible until someone happened to remember them.
 */
export const Route = createFileRoute('/admin/water')({ component: AdminWater });

function AdminWater() {
  const pending = useQuery(api.waterBodies.listPendingReview, {});
  const dedup = useQuery(api.waterBodies.listDedupCandidates, {});
  const curated = useQuery(api.waterBodies.listCurated, {});
  const [lookup, setLookup] = useState('');
  const matches = useQuery(api.waterBodies.searchByName, searchQueryArg(lookup, 8));
  const approve = useMutation(api.waterBodies.approve);
  const reject = useMutation(api.waterBodies.reject);
  const merge = useMutation(api.waterBodies.merge);

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Water bodies"
        subtitle="Review user-drawn bodies, merge duplicates, and open a lake's editor."
      />

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Open a lake
        </h2>
        <Input
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
          placeholder="Search by name to open its editor…"
          aria-label="Search lakes to edit"
        />
        {(matches ?? [])
          .filter((hit) => hit.kind === 'body')
          .map((hit) => (
            <Link
              key={hit._id}
              to="/admin/water/$id"
              params={{ id: hit.waterBodyId }}
              className="text-foreground text-sm underline underline-offset-2"
            >
              {hit.name}
              {hit.states.length > 0 ? (
                <span className="text-foreground-muted"> · {hit.states.join(', ')}</span>
              ) : null}
            </Link>
          ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Curated bodies
        </h2>
        <p className="text-foreground-muted text-sm">
          Every body carrying a prominence boost. Read the state and area columns as a check on the
          match — a boosted “South Bay” listed in ME at 2 km² is not the arm of Lake Champlain
          anyone meant.
        </p>
        {curated === undefined ? (
          <AdminEmpty>Loading…</AdminEmpty>
        ) : curated.length === 0 ? (
          <AdminEmpty>Nothing boosted yet.</AdminEmpty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>States</Th>
                <Th className="text-right">Area (km²)</Th>
                <Th className="text-right">Boost</Th>
                <Th className="text-right">Draws from</Th>
              </tr>
            </thead>
            <tbody>
              {curated.map((row) => (
                <tr key={row._id}>
                  <Td>
                    <Link
                      to="/admin/water/$id"
                      params={{ id: row._id }}
                      className="underline underline-offset-2"
                    >
                      {row.name}
                    </Link>
                  </Td>
                  <Td>{row.states.join(', ') || '—'}</Td>
                  <Td className="text-right">{(row.surfaceAreaSqM / 1e6).toFixed(1)}</Td>
                  <Td className="text-right">{row.curatedBoost.toFixed(1)}</Td>
                  <Td className="text-right">z{row.minVisibleZoom}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Pending review
        </h2>
        {pending === undefined ? (
          <AdminEmpty>Loading…</AdminEmpty>
        ) : pending.length === 0 ? (
          <AdminEmpty>No user-drawn bodies awaiting review.</AdminEmpty>
        ) : (
          pending.map((body) => (
            <Card key={body._id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-foreground text-sm">{body.name}</p>
                  <p className="text-foreground-muted text-xs">{body.type} · user-drawn</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => approve({ waterBodyId: body._id })}
                  >
                    Approve
                  </Button>
                  <ReasonDialog
                    trigger={
                      <Button variant="outline" size="sm">
                        Reject
                      </Button>
                    }
                    title={`Reject “${body.name}”`}
                    description="Removes it from the map (reversible-in-spirit; not a hard delete)."
                    confirmLabel="Reject"
                    requireReason={false}
                    reasonPlaceholder="Optional note for the audit log"
                    onConfirm={(reason) =>
                      reject({ waterBodyId: body._id, ...(reason ? { reason } : {}) })
                    }
                  />
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Suspected duplicates
        </h2>
        {dedup === undefined ? (
          <AdminEmpty>Loading…</AdminEmpty>
        ) : dedup.length === 0 ? (
          <AdminEmpty>No suspected duplicates. (Populated once Phase 8 lands.)</AdminEmpty>
        ) : (
          dedup.map(({ body, candidates }) => (
            <Card key={body._id}>
              <CardContent className="flex flex-col gap-2">
                <p className="text-foreground text-sm">{body.name}</p>
                <p className="text-foreground-muted text-xs">Merge into the canonical body:</p>
                <div className="flex flex-wrap gap-2">
                  {candidates.length === 0 ? (
                    <span className="text-foreground-muted text-xs">No candidates recorded.</span>
                  ) : (
                    candidates.map((c) => (
                      <ReasonDialog
                        key={c.id}
                        trigger={
                          <Button variant="outline" size="sm">
                            Merge → {c.name}
                          </Button>
                        }
                        title={`Merge “${body.name}” into “${c.name}”`}
                        description="Re-points reports/hazards/bounties to the survivor and tombstones this one."
                        confirmLabel="Merge"
                        confirmVariant="default"
                        requireReason={false}
                        onConfirm={(reason) =>
                          merge({
                            survivorId: c.id as Id<'waterBodies'>,
                            loserId: body._id,
                            ...(reason ? { reason } : {}),
                          })
                        }
                      />
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
