import { api } from '@skating/convex/api';
import { formatAreaAcres, standingReasonLabel } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader, Table, Td, Th } from '../components/admin/adminUi';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * Corpus standing — **what is off the active map, and why; and what just came back** (N7b).
 *
 * The founder's trajectory is a corpus of a few hundred actually-skated lakes out of 25,000 known,
 * reached by machines (the seed, the July rollover, the campaign prunes) that shelve rather than
 * delete. A machine that changes the shape of the map needs a page where a person sees it do so;
 * this is that page. Five lanes, one per non-active standing, newest first, plus the list of bodies
 * that recently became active again — the one place a report silently un-shelving a pond is seen.
 *
 * Every row links into the lake editor, whose Standing card is where the act happens. This page
 * lists; it does not act — a lane with buttons on every row is how a fat thumb un-shelves a pond.
 */
export const Route = createFileRoute('/admin/water/standing')({ component: StandingPage });

type Lane = 'inactive' | 'not_in_campaign' | 'moderator' | 'no_public_access' | 'removed';

const LANES: readonly Lane[] = [
  'inactive',
  'not_in_campaign',
  'moderator',
  'no_public_access',
  'removed',
];

const LANE_LABELS: Record<Lane, string> = {
  inactive: standingReasonLabel('inactive'),
  not_in_campaign: standingReasonLabel('not_in_campaign'),
  moderator: standingReasonLabel('moderator'),
  no_public_access: standingReasonLabel('no_public_access'),
  removed: 'Removed',
};

const LANE_BLURBS: Record<Lane, string> = {
  inactive:
    'Nobody has reported, tracked or marked anything here in three seasons, and nobody has boosted or favourited it — the July rollover, or the seed. A report brings it back on its own.',
  not_in_campaign:
    'The admission rules refuse it now — a raised acreage floor, a class the merge no longer takes. Shelved by a campaign prune rather than deleted. A report brings it back and keeps it by request.',
  moderator:
    'Set dormant by hand, with a note the skater reads. Only a moderator brings these back.',
  no_public_access:
    'A moderator ruled there is no lawful way in. Dormant on that account; the ruling is changed in the lake editor’s Access section, not here.',
  removed:
    'Taken off the map (D48) — a landowner request, junk, a duplicate. Draws only when zoomed right in, with the reason; absent from search. Restore from the lake editor.',
};

function StandingPage() {
  const [lane, setLane] = useState<Lane>('inactive');
  const rows = useQuery(api.standing.listLane, { lane });
  const recent = useQuery(api.standing.listRecentActivations, {});

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Standing"
        subtitle="What is off the active map and why — and what just came back."
      />

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Recently activated
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-foreground-muted text-sm">
              Bodies that became active again, newest first, with what brought them back and what
              the enrichment passes have not yet given them.
            </p>
            {recent === undefined ? null : recent.length === 0 ? (
              <AdminEmpty>Nothing has come back yet.</AdminEmpty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Lake</Th>
                    <Th>When</Th>
                    <Th>Via</Th>
                    <Th>Awaiting</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((row) => (
                    <tr key={row._id}>
                      <Td>
                        <LakeLink id={row._id} name={row.name} states={row.states} />
                      </Td>
                      <Td>{new Date(row.activatedAt).toLocaleDateString()}</Td>
                      <Td className="font-mono text-xs">{row.via ?? '—'}</Td>
                      <Td className="font-mono text-xs">
                        {row.missing.length === 0 ? 'nothing' : row.missing.join(', ')}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Off the active map
        </h2>
        <div className="flex flex-wrap gap-2">
          {LANES.map((l) => (
            <Button
              key={l}
              variant={l === lane ? 'default' : 'outline'}
              size="sm"
              onClick={() => setLane(l)}
            >
              {LANE_LABELS[l]}
            </Button>
          ))}
        </div>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-foreground-muted text-sm">{LANE_BLURBS[lane]}</p>
            {rows === undefined ? null : rows.rows.length === 0 ? (
              <AdminEmpty>Nothing in this lane.</AdminEmpty>
            ) : (
              <>
                <Table>
                  <thead>
                    <tr>
                      <Th>Lake</Th>
                      <Th>Acres</Th>
                      <Th>Since</Th>
                      <Th>Last activity</Th>
                      <Th>Flags</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.rows.map((row) => (
                      <tr key={row._id}>
                        <Td>
                          <LakeLink id={row._id} name={row.name} states={row.states} />
                        </Td>
                        <Td className="font-mono text-xs">{formatAreaAcres(row.surfaceAreaSqM)}</Td>
                        <Td>{new Date(row.standing.since).toLocaleDateString()}</Td>
                        <Td>
                          {row.lastActivityAt === undefined
                            ? 'never'
                            : new Date(row.lastActivityAt).toLocaleDateString()}
                        </Td>
                        <Td className="font-mono text-xs">
                          {[
                            row.includedByRequest ? 'by request' : null,
                            row.curatedBoost > 0 ? `boost ${row.curatedBoost}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {rows.truncated ? (
                  <p className="text-foreground-muted text-xs">
                    Showing the newest {rows.rows.length}; the lane holds more.
                  </p>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function LakeLink({ id, name, states }: { id: string; name: string; states: string[] }) {
  return (
    <>
      <Link to="/admin/water/$id" params={{ id }} className="underline underline-offset-2">
        {name || '(unnamed)'}
      </Link>
      <span className="ml-2 font-mono text-foreground-muted text-xs">{states.join(' ')}</span>
    </>
  );
}
