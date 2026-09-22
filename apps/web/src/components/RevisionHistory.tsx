import { api } from '@skating/convex/api';
import { formatRelativeTime, type RevisionStep, revisionHistory } from '@skating/core';
import { useQuery } from 'convex/react';
import { useState } from 'react';
import { useRole } from '../lib/useRole';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

/**
 * What an author changed (D205, A10-5) — the moderator's comparison, owed since A10-3.
 *
 * Authors have been able to edit their own Posts and Reports since A10-3, and every edit writes
 * what the row used to say to `contentRevisions` before it patches. A skater sees only *Edited* on
 * the card; this is the other end of that promise — a moderator deciding whether an edit changed a
 * **claim** (a thickness, a suitability, a *don't go*) rather than a wording.
 *
 * The comparison is core's (`revisionHistory`), so what counts as a change and how a value reads
 * are one answer and not this component's. All this does is ask, and draw.
 *
 * Nothing renders for a non-moderator, and the query refuses one anyway — the hidden button is the
 * nicety, the server is the boundary.
 */
export function RevisionHistory({
  targetType,
  targetId,
  timeZone,
}: {
  targetType: 'post' | 'report';
  targetId: string;
  /** The body's zone, so an end time in the history reads as the skater wrote it. */
  timeZone?: string;
}) {
  const { isModerator } = useRole();
  const [open, setOpen] = useState(false);
  const count = useQuery(
    api.contentRevisions.countForTarget,
    isModerator ? { targetType, targetId } : 'skip',
  );

  if (!isModerator || !count) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit history · {count}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              What the author changed{targetType === 'post' ? ' on this post' : ''}
            </DialogTitle>
          </DialogHeader>
          {open ? (
            <HistoryBody
              targetType={targetType}
              targetId={targetId}
              {...(timeZone !== undefined ? { timeZone } : {})}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryBody({
  targetType,
  targetId,
  timeZone,
}: {
  targetType: 'post' | 'report';
  targetId: string;
  timeZone?: string;
}) {
  const data = useQuery(api.contentRevisions.listForTarget, { targetType, targetId });
  if (data === undefined) {
    return <p className="text-foreground-muted text-sm">Reading the history…</p>;
  }
  const steps = revisionHistory(data.revisions, data.live, {
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  if (steps.length === 0) {
    return <p className="text-foreground-muted text-sm">This one has never been edited.</p>;
  }
  const author = data.revisions[0]?.authorUsername;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-foreground-muted text-sm">
        {steps.length === 1 ? 'One edit' : `${steps.length} edits`}
        {author ? `, by ${author}` : ''}. Newest last — each block is what that edit moved.
      </p>
      {steps.map((step) => (
        <Step key={step.replacedAt} step={step} />
      ))}
    </div>
  );
}

function Step({ step }: { step: RevisionStep }) {
  return (
    <section className="rounded-lg border border-border p-3">
      <p className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Edited {formatRelativeTime(step.replacedAt, Date.now())}
      </p>
      {step.changes.length === 0 ? (
        // A revision with no visible change is a save that touched nothing the block carries —
        // worth showing as itself rather than as an empty row a moderator has to interpret.
        <p className="pt-2 text-foreground-muted text-sm">
          Nothing in the report's content changed.
        </p>
      ) : (
        <dl className="flex flex-col gap-2 pt-2">
          {step.changes.map((change) => (
            <div key={change.field} className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
              <dt className="text-foreground-muted">
                {change.label}
                {/* Marked, never ranked: a moderator decides, and this only keeps a thickness
                    change from being lost among reworded notes (D3). */}
                {change.claim ? (
                  <span className="text-warning" title="A claim about the ice">
                    {' '}
                    ●
                  </span>
                ) : null}
              </dt>
              <dd className="flex flex-col gap-0.5">
                <span className="text-foreground-muted line-through">
                  {change.before ?? <em className="not-italic">nothing</em>}
                </span>
                <span className="text-foreground">
                  {change.after ?? <em className="text-foreground-muted">cleared</em>}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
