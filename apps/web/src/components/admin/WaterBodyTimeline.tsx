import { api } from '@skating/convex/api';
import { humanizeEnum } from '@skating/core';
import { useQuery } from 'convex/react';

/**
 * The per-lake activity timeline on `/admin/water/$id` (N6c Workstream F1).
 *
 * **This is a UI component and no backend at all**, which is the finding that made F1 worth doing:
 * `moderation.listActions` has always accepted `targetType: 'waterbody'` + `targetId`, read
 * `by_target` newest-first and resolved the actor. Every human write to a body already landed there —
 * depth, curated boost, sample points, sub-area create/redraw/rename, put-ins, features — and nobody
 * has ever been able to look at it. That is why five mis-matched bodies from the Phase-2.5 seed
 * stayed invisible until N2 built a screen.
 *
 * **Human writes only.** ETL runs are audited separately, on `/admin/imports` (F2), because one row
 * per body per import is a different feature with a different cost — an 8k-row audit trail per run —
 * and the per-body question is already answered by the depth provenance stored on the row.
 *
 * **No undo.** Read the old value off the `prev` line and re-enter it: one click short, and zero new
 * invariants. An undo affordance over a heterogeneous audit log is a much larger thing than it looks.
 */
export function WaterBodyTimeline({ waterBodyId }: { waterBodyId: string }) {
  const actions = useQuery(api.moderation.listActions, {
    targetType: 'waterbody',
    targetId: waterBodyId,
    limit: 50,
  });

  if (actions === undefined) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">History</h2>
      {actions.length === 0 ? (
        // Said plainly rather than hidden: on a corpus body this is the *expected* state, and an
        // absent section would leave a moderator wondering whether the log was broken or empty.
        <p className="text-foreground-muted text-sm">
          No human edits recorded. Imports are listed under Imports.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {actions.map((action) => (
            <li key={action.id} className="border-border border-l-2 pl-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-foreground">{humanizeEnum(action.action)}</span>
                <span className="text-foreground-muted text-xs">
                  {action.actor?.displayName ?? 'Unknown'} ·{' '}
                  {new Date(action.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-foreground-muted">{action.reason}</p>
              <ChangeLine metadata={action.metadata} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The before/after line (F1's first gap).
 *
 * An audit row that records only what a field *became* can answer "who changed this" and never
 * "changed it from what", which is most of what someone reading a timeline actually wants.
 * `setDepth` / `clearDepthOverride` established the `prev` convention and `setReferenceLinks` follows
 * it; older rows have no `prev`, so this renders nothing rather than implying a change from nothing.
 */
function ChangeLine({ metadata }: { metadata: unknown }) {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const prev = (metadata as { prev?: unknown }).prev;
  if (typeof prev !== 'object' || prev === null) return null;

  const entries = Object.entries(prev as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return null;

  return (
    <p className="text-foreground-muted text-xs">
      {entries.map(([key, value]) => (
        <span key={key} className="mr-3">
          was {key}: <code>{summarize(value)}</code>
        </span>
      ))}
    </p>
  );
}

/** A previous value as one short string. Arrays and objects are counted, not dumped. */
function summarize(value: unknown): string {
  if (value === null) return 'none';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : `${value.length} item(s)`;
  if (typeof value === 'object') return 'set';
  return String(value);
}
