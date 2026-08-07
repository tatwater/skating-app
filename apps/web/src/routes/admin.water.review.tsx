import { api } from '@skating/convex/api';
import { isAdvisoryReviewReason, REVIEW_REASON_PRIORITY, type ReviewReason } from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader, Table, Td, Th } from '../components/admin/adminUi';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/**
 * The intake review queue — **rows that were computed, stored, and shown to nobody** (N7).
 *
 * `confidence.ts` scored every body in the corpus, `merge.ts` wrote the reasons onto the rows, and
 * the trail ended there: the first intake audit found the queue computed and *discarded*, and fixing
 * that stored 2,010 rows without ever giving them a surface. This is the surface.
 *
 * ## Two questions, not one number
 *
 * The tabs separate **repair** from **curation**, and that separation is the point rather than
 * decoration. Since `nameClaims` landed, a name conflict costs nothing — both names are stored and
 * both are searchable — so those 463 rows are "could be better", while a duplicate candidate is two
 * lakes rendering where there is one. A single count of 2,010 answers neither question and is the
 * reason nobody opened it.
 *
 * ## Ordered by prominence, inside each reason
 *
 * `by_review_reason` is `['reviewReason', 'displayScore']` and this reads it descending, so the queue
 * opens on lakes people have heard of. A queue that opens on an unnamed four-acre pond is one nobody
 * finishes.
 */
export const Route = createFileRoute('/admin/water/review')({ component: ReviewQueue });

const REASON_LABELS: Record<ReviewReason, string> = {
  'duplicate-candidate': 'Duplicate candidates',
  'same-source-duplicate': 'One catalogue, twice',
  'bay-without-parent': 'Bays with no parent',
  'class-conflict': 'Class conflicts',
  'name-conflict': 'Name conflicts',
};

const REASON_BLURBS: Record<ReviewReason, string> = {
  'duplicate-candidate':
    'Two separate bodies whose outlines overlap. The corpus renders both and search returns both, so this is the one a skater can see going wrong.',
  'same-source-duplicate':
    'One catalogue carrying the same lake twice — the case OSM cannot see about itself and NHD can.',
  'bay-without-parent':
    'An arm of something larger, with nothing in the corpus to attach it to, so it is stored as `unclassified` rather than as a bay.',
  'class-conflict':
    'The catalogues disagree about what kind of water this is, and our own rules did not settle it. A federal open-water class beating an OSM wetland tag is NOT here — that one is settled.',
  'name-conflict':
    'Two publishers, two names. Both are stored and both are searchable, so nothing is broken — this is choosing which one displays.',
};

function ReviewQueue() {
  const counts = useQuery(api.waterBodies.reviewQueueCounts, {});
  const [reason, setReason] = useState<ReviewReason>('duplicate-candidate');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const page = useQuery(api.waterBodies.listReviewQueue, { reason, cursor });

  const shown = (r: ReviewReason) => {
    const c = counts?.[r];
    if (!c) return '—';
    return c.capped ? `${c.count}+` : String(c.count);
  };

  const repair = REVIEW_REASON_PRIORITY.filter((r) => !isAdvisoryReviewReason(r));
  const advisory = REVIEW_REASON_PRIORITY.filter(isAdvisoryReviewReason);

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title="Intake review"
        subtitle="What the merge could not settle by itself, worst first."
      />

      <div className="flex flex-col gap-3">
        {(
          [
            ['Needs a decision', repair],
            ['Could be improved', advisory],
          ] as const
        ).map(([heading, reasons]) => (
          <section key={heading} className="flex flex-col gap-2">
            <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
              {heading}
            </h2>
            <div className="flex flex-wrap gap-2">
              {reasons.map((r) => (
                <Button
                  key={r}
                  variant={r === reason ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setReason(r);
                    setCursor(undefined);
                  }}
                >
                  {REASON_LABELS[r]}{' '}
                  <span className="ml-1.5 font-mono text-xs opacity-70">{shown(r)}</span>
                </Button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <p className="text-foreground-muted text-sm">{REASON_BLURBS[reason]}</p>

          {page === undefined ? null : page.rows.length === 0 ? (
            <AdminEmpty>Nothing left under this reason.</AdminEmpty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Lake</Th>
                  <Th>Acres</Th>
                  <Th>What is disputed</Th>
                  <Th>Catalogues</Th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row._id}>
                    <Td>
                      <Link
                        to="/admin/water/$id"
                        params={{ id: row._id }}
                        className="underline underline-offset-2"
                      >
                        {row.name || '(unnamed)'}
                      </Link>
                      <span className="ml-2 font-mono text-foreground-muted text-xs">
                        {row.states.join(' ')}
                      </span>
                    </Td>
                    <Td>{row.acres.toLocaleString()}</Td>
                    <Td>
                      {/* The competing claims inline, so a name conflict is decidable from the list
                          rather than only after opening the lake. */}
                      {reason === 'name-conflict' ? (
                        <span className="text-sm">
                          {row.nameClaims.map((c) => `${c.value} [${c.source}]`).join('  ·  ')}
                        </span>
                      ) : (
                        <span className="font-mono text-xs">{row.reviewReasons.join(' · ')}</span>
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">
                        {[row.osmId ? 'osm' : null, row.nhdId ? 'nhd' : null]
                          .filter(Boolean)
                          .join(' + ') || '—'}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {page && !page.isDone ? (
            <Button variant="outline" size="sm" onClick={() => setCursor(page.cursor)}>
              Next page
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
