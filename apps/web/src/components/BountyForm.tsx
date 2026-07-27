import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { DEFAULT_BOUNTY_REWARD_POINTS, MAX_OPEN_BOUNTIES_PER_DAY } from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useAction, useQuery } from 'convex/react';
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
  // Named bays on this lake (N2/D60) — the whole lake stays the default, because most lakes have
  // none and asking "which part?" of a pond is noise.
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  const bays = (subAreas ?? []).filter((s) => !s.removed);
  const [subAreaId, setSubAreaId] = useState<string>('');

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const id = await create({
        waterBodyId,
        ...(subAreaId ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
      });
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
          {bays.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="font-medium text-foreground">Which part?</span>
              <select
                className="rounded-md border border-border bg-surface px-2 py-1.5"
                value={subAreaId}
                onChange={(e) => setSubAreaId(e.target.value)}
              >
                <option value="">Anywhere on {bodyName}</option>
                {bays.map((bay) => (
                  <option key={bay._id} value={bay._id}>
                    {bay.name}
                  </option>
                ))}
              </select>
              <span className="text-foreground-muted text-xs">
                Narrowing the ask means only a report from that part of the lake will fulfil it —
                and a recent report somewhere else won’t stop you asking.
              </span>
            </label>
          ) : null}
          <ul className="list-disc pl-5 text-foreground-muted">
            <li>
              Only if the lake doesn’t already have a recent report — a well-confirmed read keeps it
              covered longer, and a big thaw or freeze reopens it sooner.
            </li>
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
