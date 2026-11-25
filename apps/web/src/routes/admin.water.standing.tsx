import { api } from '@skating/convex/api';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader, Table, Td, Th } from '../components/admin/adminUi';
import { Card, CardContent } from '../components/ui/card';

/**
 * Corpus standing — **what just came back to the active map** (A07b).
 *
 * The founder's trajectory is a corpus of a few hundred actually-skated lakes out of 25,000 known,
 * reached by machines (the seed, the July rollover, the campaign prunes) that shelve rather than
 * delete — and a report on a shelved pond brings it back with no person in the loop. This page is
 * where that is seen: the bodies that recently became active again, newest first, with what
 * brought each back and what the enrichment passes have not yet given it.
 *
 * What is off the active map, and why, is the Corpus library's lanes now (`/admin/corpus`); this
 * page kept only what no console page draws yet. Every row links into the lake editor, whose
 * Standing card is where the act happens. This page lists; it does not act.
 */
export const Route = createFileRoute('/admin/water/standing')({ component: StandingPage });

function StandingPage() {
  const recent = useQuery(api.standing.listRecentActivations, {});

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader title="Standing" subtitle="What just came back to the active map." />

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
