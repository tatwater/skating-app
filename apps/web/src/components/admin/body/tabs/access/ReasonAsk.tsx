import { type ReactElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogReason,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/kit/alert-dialog';

/**
 * The reason dialog, for a Body console action that takes something away (D226: a reason only
 * then) — ruling no public access, hiding a put-in, declining or dismissing an ask. On the kit's
 * AlertDialog: the reason box, any extra fields, and the action inert until there's a reason to send
 * (or, with `optional`, not). A refusal is a toast (D268); the dialog stays open over the kept reason,
 * so it can be corrected and sent again. Shared by Access and Places.
 */
export type ReasonAskProps = {
  /** The button that opens it. */
  trigger: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  /** The action's label ("Hide", "Decline"). */
  confirm: string;
  /** Who reads the reason, on the box's kicker ("Reason · the skaters read it"). */
  label?: ReactNode;
  /** The reason may be left empty (a note, not a reason). */
  optional?: boolean;
  placeholder?: string;
  /** Fields above the reason (a choice of why). */
  extra?: ReactNode;
  /**
   * The most the reason may hold: the cap its write's server field refuses past, from core's
   * `textCaps` (or the audit log's, `AUDIT_REASON_MAX`) — never a copied number.
   */
  maxLength: number;
  /** Sends it. Resolves whether it landed: the dialog closes, or stays open over the reason. */
  onConfirm: (reason: string) => Promise<boolean>;
};

export function ReasonAsk({
  trigger,
  title,
  description,
  confirm,
  label = 'Reason',
  optional = false,
  placeholder,
  extra,
  maxLength,
  onConfirm,
}: ReasonAskProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // This opening of the dialog: a send's answer closes only the opening that sent it. The dialog
  // going (its page left) ends every opening — at the commit that removes it (a layout effect),
  // never a passive cleanup that runs later with the dialog already off screen.
  const opening = useRef(0);
  useLayoutEffect(
    () => () => {
      opening.current++;
    },
    [],
  );
  const trimmed = reason.trim();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          opening.current++;
          setReason('');
        }
        setOpen(next);
      }}
    >
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent data-slot="reason-ask">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description != null && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogBody>
          {extra}
          {/* A sent reason is held while its write is out: the dialog closes when it lands, so
              words typed then could never be sent — the field takes none. */}
          <AlertDialogReason
            label={label}
            placeholder={placeholder}
            maxLength={maxLength}
            value={reason}
            readOnly={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            waiting={(!optional && trimmed.length === 0) || busy}
            onClick={() => {
              setBusy(true);
              const mine = opening.current;
              void onConfirm(trimmed).then(
                (landed) => {
                  setBusy(false);
                  if (landed && opening.current === mine) setOpen(false);
                },
                // A sender that threw rather than answering: never a dialog stuck waiting.
                () => setBusy(false),
              );
            }}
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
