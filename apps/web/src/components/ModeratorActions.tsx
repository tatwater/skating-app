import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faShieldHalved } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import { useState } from 'react';
import { useRole } from '@/lib/useRole';
import { usePlace } from './admin/place';
import { useSaidMutation } from './admin/saidMutation';
import { Button } from './ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

/** Whether the current user is at least a moderator (D37) — gates the inline actions below. */
export function useIsModerator(): boolean {
  const profile = useQuery(api.profiles.current, {});
  return profile?.role === 'moderator' || profile?.role === 'admin';
}

/**
 * Role-gated inline moderator takedown (D32/D37) — hide or remove a **visible** report/comment, each
 * requiring a reason (written to the `moderationActions` audit log). This is the minimal founder
 * takedown path; the full queue + restore-of-hidden-content lives in the Phase 07 `/admin` surface.
 * Renders nothing for non-moderators, so callers can drop it in unconditionally.
 */
export function ModeratorActions({
  targetType,
  targetId,
  label = 'Moderate',
}: {
  targetType: 'report' | 'post' | 'comment' | 'hazard';
  targetId: string;
  /** The trigger's text — set when two of these sit side by side (a Report and its Post). */
  label?: string;
}) {
  const { canModerate } = useRole();
  // Its place: the element that shows its refusal — drawn or not when the answer comes. A viewer
  // who lost the permission meanwhile has no dialog drawn: the net says it in a toast.
  const place = usePlace();
  const setStatus = useSaidMutation(api.moderation.setModerationStatus, place);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // While a takedown is out the dialog holds open, so its refusal is said here and never into a
  // dialog that has closed (D268); the net speaks once its refusal line isn't drawn.
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // `canModerate`, not `isModerator`: a departing operator's takedown mutations are refused by
  // `requireContributorRole`, so showing the control would offer a button that throws.
  if (!canModerate) return null;

  const act = async (status: 'hidden' | 'removed') => {
    if (!reason.trim()) {
      setError('A reason is required.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await setStatus({ targetType, targetId, status, reason: reason.trim() });
    } catch {
      setError('Could not apply the action. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <FontAwesomeIcon icon={faShieldHalved} className="size-4" />
        {label}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Moderate this {targetType}</DialogTitle>
          <DialogDescription>
            Hiding or removing writes an audit record. A reason is required.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mod-reason">Reason</Label>
          <Textarea
            id="mod-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being taken down?"
          />
        </div>
        <p ref={place.ref} className="text-destructive text-sm empty:hidden">
          {error}
        </p>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Button
            variant="secondary"
            onClick={() => act('hidden')}
            disabled={!reason.trim() || busy}
          >
            Hide
          </Button>
          <Button
            variant="destructive"
            onClick={() => act('removed')}
            disabled={!reason.trim() || busy}
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
