import { type ReactNode, useState } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

/**
 * A reusable "collect a reason, then confirm" dialog for audited operator actions (D37). Every
 * lifecycle/moderation mutation requires a non-empty reason for the `moderationActions` log; this
 * centralizes that flow — the trigger, the reason textarea, error surfacing, and close-on-success —
 * so each call site is one `onConfirm(reason)` callback. Optional `extraFields` render above the
 * reason (e.g. a suspension end-date), and `requireReason={false}` allows a bare confirm.
 */
export function ReasonDialog({
  trigger,
  title,
  description,
  confirmLabel,
  confirmVariant = 'destructive',
  reasonPlaceholder = 'Why?',
  requireReason = true,
  extraFields,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  confirmLabel: string;
  confirmVariant?: 'default' | 'destructive' | 'secondary' | 'outline';
  reasonPlaceholder?: string;
  requireReason?: boolean;
  extraFields?: ReactNode;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blocked = requireReason && !reason.trim();

  const confirm = async () => {
    if (blocked) {
      setError('A reason is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      setOpen(false);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {extraFields}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reason-dialog-input">Reason</Label>
          <Textarea
            id="reason-dialog-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
          />
        </div>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={confirm} disabled={blocked || busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
