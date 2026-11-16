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
import { askFrom, usePlace } from './place';

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
  onOpenChange,
  confirmDisabled = false,
  refusalOnPage = false,
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
  /** Told when the dialog opens or closes — for a caller that freezes what it is about at open. */
  onOpenChange?: (open: boolean) => void;
  /** Hold the confirm while what it would act on is no longer the caller's to act on. */
  confirmDisabled?: boolean;
  /**
   * Its confirm says a refusal on the page (a banner), not only here: the writes it starts keep the
   * page's own place rather than this dialog's, so one answered after the dialog has gone (its row
   * decided by a colleague) is said on the page once — never in a toast as well.
   */
  refusalOnPage?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Its place: the element that shows its refusal, drawn or not when the answer comes. A write its
  // confirm starts belongs to it (`askFrom`) — gone, the Legacy net says the refusal in a toast —
  // unless the confirm says it on the page (`refusalOnPage`), whose place the write keeps.
  const place = usePlace();

  const blocked = requireReason && !reason.trim();

  const confirm = async () => {
    if (blocked) {
      setError('A reason is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const trimmed = reason.trim();
      await (refusalOnPage ? onConfirm(trimmed) : askFrom(place, () => onConfirm(trimmed)));
      setOpen(false);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      // Held open while its write is out (Esc and an outside press included, as Cancel already is):
      // the answer is said here, never into a dialog that has closed (D268).
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
      }}
    >
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
        <p ref={place.ref} className="text-destructive text-sm empty:hidden">
          {error}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            onClick={confirm}
            disabled={blocked || busy || confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
