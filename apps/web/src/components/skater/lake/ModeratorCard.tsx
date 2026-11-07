import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faShieldHalved } from '@fortawesome/sharp-light-svg-icons';
import { faArrowUpRightFromSquare } from '@fortawesome/sharp-regular-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { PublicAccessVerdict } from '@skating/core';
import { useMutation } from 'convex/react';
import { type ReactNode, useState } from 'react';

import { Button, buttonVariants } from '@/components/kit/button';
import { useRole } from '@/lib/useRole';

/**
 * What a moderator also sees on a lake (board 1.14): the console's register at a skater's size — a
 * dashed hairline card with a shield, never a pill. Two of them on About: the access ruling (under
 * Public access) and the tools (at the tab's end, the lake editor in a new tab, plus approve and
 * reject on a pending user-drawn body). **Capability-gated** like the old `ModeratorActions`:
 * `canModerate`, not `isModerator`, so a departing operator isn't offered a write the server
 * refuses. Every Convex function hard-gates on the role regardless.
 */
export function ModeratorFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      data-slot="moderator-card"
      className="flex flex-col gap-(--space-2_5) border border-dashed border-line2 p-(--space-3_5)"
    >
      <span className="flex items-center gap-(--space-2) text-kick font-semibold tracking-kick text-fg1 uppercase">
        <FontAwesomeIcon icon={faShieldHalved} aria-hidden="true" className="h-[1.1em] text-fg2" />
        {title}
        <span className="ms-auto text-kick font-medium tracking-label text-fg3">Moderators</span>
      </span>
      {children}
    </section>
  );
}

/** The access ruling's three buttons — the ruling a skater sees above them is the moderator's. */
export function AccessRulingCardView({
  verdict,
  pendingCount,
  busy,
  error,
  onRule,
}: {
  verdict: PublicAccessVerdict | undefined;
  pendingCount: number;
  busy: boolean;
  error: string | null;
  onRule: (verdict: PublicAccessVerdict | null) => void;
}) {
  return (
    <ModeratorFrame title="Access ruling">
      <p className="m-0 text-assist text-fg2">
        {pendingCount > 0
          ? `${pendingCount} ${pendingCount === 1 ? 'report' : 'reports'} of no public access ${pendingCount === 1 ? 'is' : 'are'} waiting.`
          : 'No reports of no public access are waiting.'}{' '}
        A ruling shows to every skater on this lake.
      </p>
      <div className="flex flex-wrap gap-(--space-2)">
        <Button
          size="sm"
          disabled={busy || verdict === 'none'}
          data-attr="mod-access-none"
          onClick={() => onRule('none')}
        >
          Mark no public access
        </Button>
        <Button
          size="sm"
          disabled={busy || verdict === 'open'}
          data-attr="mod-access-open"
          onClick={() => onRule('open')}
        >
          Confirm public access
        </Button>
        {verdict !== undefined && (
          <Button
            size="sm"
            disabled={busy}
            data-attr="mod-access-clear"
            onClick={() => onRule(null)}
          >
            Clear
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="m-0 text-assist text-warn">
          {error}
        </p>
      )}
    </ModeratorFrame>
  );
}

export function AccessRulingCard({
  waterBodyId,
  verdict,
  pendingCount,
}: {
  waterBodyId: string;
  verdict: PublicAccessVerdict | undefined;
  pendingCount: number;
}) {
  const { canModerate } = useRole();
  const rule = useMutation(api.waterBodies.setPublicAccess);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canModerate) return null;
  return (
    <AccessRulingCardView
      verdict={verdict}
      pendingCount={pendingCount}
      busy={busy}
      error={error}
      onRule={(next) => {
        setBusy(true);
        setError(null);
        rule({ waterBodyId: waterBodyId as Id<'waterBodies'>, verdict: next })
          .catch(() => setError('Could not save the ruling. Try again.'))
          .finally(() => setBusy(false));
      }}
    />
  );
}

/** The tools card: the lake editor, and the review of a pending user-drawn body. */
export function ModeratorToolsView({
  editorHref,
  pendingReview,
  busy,
  onApprove,
  onReject,
}: {
  editorHref: string;
  pendingReview: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <ModeratorFrame title="Moderator tools">
      <p className="m-0 text-assist text-fg2 [text-wrap:pretty]">
        Depth, shape, names, bays, put-ins, posted rules, and the links above are all edited in the
        lake editor, with the audit trail.
      </p>
      <div className="flex flex-wrap gap-(--space-2)">
        <a
          href={editorHref}
          target="_blank"
          rel="noopener noreferrer"
          data-attr="mod-edit-lake"
          className={buttonVariants({ variant: 'link', size: 'sm' })}
        >
          Edit this lake
          <FontAwesomeIcon
            icon={faArrowUpRightFromSquare}
            aria-hidden="true"
            className="h-[0.9em]"
          />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        {pendingReview && (
          <>
            <Button size="sm" disabled={busy} data-attr="mod-approve" onClick={onApprove}>
              Approve this lake
            </Button>
            <Button size="sm" disabled={busy} data-attr="mod-reject" onClick={onReject}>
              Reject
            </Button>
          </>
        )}
      </div>
    </ModeratorFrame>
  );
}

export function ModeratorTools({
  body,
}: {
  body: { _id: string; source: string; reviewStatus?: 'pending' | 'approved' | 'rejected' };
}) {
  const { canModerate } = useRole();
  const approve = useMutation(api.waterBodies.approve);
  const reject = useMutation(api.waterBodies.reject);
  const [busy, setBusy] = useState(false);
  if (!canModerate) return null;
  const waterBodyId = body._id as Id<'waterBodies'>;
  const run = (write: () => Promise<unknown>) => {
    setBusy(true);
    write()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <ModeratorToolsView
      editorHref={`/admin/water/${body._id}`}
      pendingReview={body.source === 'user' && body.reviewStatus === 'pending'}
      busy={busy}
      onApprove={() => run(() => approve({ waterBodyId }))}
      onReject={() => run(() => reject({ waterBodyId }))}
    />
  );
}
