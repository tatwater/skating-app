import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  DEFAULT_BOUNTY_REWARD_POINTS,
  FRESH_REPORT_HOURS,
  MAX_OPEN_BOUNTIES_PER_DAY,
} from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useAction } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

/**
 * Post-a-bounty dialog (D10/D17) — "ask for fresh eyes on this lake." Creation is a single confirm: the
 * only inputs the server needs are the water body (the reward + eligibility fan-out are server-owned). The
 * two junk controls surface as inline copy, and their server rejections (already-fresh, at-cap, minor) are
 * shown verbatim so the requester knows *why* it didn't post rather than silently failing.
 */
export function BountyForm({
  waterBodyId,
  bodyName,
  open,
  onOpenChange,
}: {
  waterBodyId: Id<'waterBodies'>;
  bodyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useAction(api.bounties.create);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const id = await create({ waterBodyId });
      onOpenChange(false);
      navigate({ to: '/bounty/$id', params: { id } });
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : 'Could not post the bounty — check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post a bounty on {bodyName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-foreground-muted">
            A bounty asks recent skaters to check {bodyName} and post a fresh report. When you mark
            a fulfilling report helpful, its author earns{' '}
            <span className="font-medium text-foreground">
              {DEFAULT_BOUNTY_REWARD_POINTS} bounty points
            </span>
            .
          </p>
          <ul className="list-disc pl-5 text-foreground-muted">
            <li>Only if there’s no fresh report in the last {FRESH_REPORT_HOURS} hours.</li>
            <li>Up to {MAX_OPEN_BOUNTIES_PER_DAY} open bounties at a time.</li>
          </ul>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? 'Posting…' : 'Post bounty'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
