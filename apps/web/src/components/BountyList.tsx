import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { TrustAvatar } from './TrustDisplay';
import { Badge } from './ui/badge';

/** "expires in N days / hours" — a bounty's remaining lifetime, humanized for the card. */
export function expiryLabel(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expiring';
  const hours = ms / 3_600_000;
  if (hours < 24) return `expires in ${Math.max(1, Math.round(hours))}h`;
  const days = Math.round(hours / 24);
  return `expires in ${days}d`;
}

/**
 * The open bounties on a body (per-body drawer surface, D47) — requester (ringed by trust), reward, how
 * many candidate reports have attached, and remaining lifetime. Each row links to the `/bounty/$id`
 * detail. Renders nothing while empty so the drawer stays quiet on a lake nobody’s asked about.
 */
export function BountyList({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const bounties = useQuery(api.bounties.listForBody, { waterBodyId });
  if (!bounties || bounties.length === 0) return null;
  const now = Date.now();

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Open bounties
      </h3>
      {bounties.map((b) => (
        <Link key={b._id} to="/bounty/$id" params={{ id: b._id }} className="block">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-2.5 text-sm transition-colors hover:bg-surface-muted">
            <TrustAvatar
              displayName={b.requester.displayName}
              trustClass={b.requester.trustClass}
              size={24}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-foreground">Requested by {b.requester.displayName}</p>
              <p className="text-foreground-muted text-xs">
                {b.fulfillingCount > 0
                  ? `${b.fulfillingCount} candidate report${b.fulfillingCount === 1 ? '' : 's'} · `
                  : ''}
                {expiryLabel(b.expiresAt, now)}
              </p>
            </div>
            <Badge variant="secondary">{b.rewardPoints} pts</Badge>
          </div>
        </Link>
      ))}
    </div>
  );
}
