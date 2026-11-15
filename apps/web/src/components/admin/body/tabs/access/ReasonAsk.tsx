import { type ReactElement, type ReactNode, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogReason,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/kit/alert-dialog';

import { errorText } from '../../../adminUi';

/**
 * The reason dialog, for a Body console action that takes something away (D226: a reason only
 * then) — ruling no public access, hiding a put-in, declining or dismissing an ask. On the kit's
 * AlertDialog: the reason box, any extra fields, the server's refusal over the kept reason, and the
 * action inert until there's a reason to send (or, with `optional`, not). Shared by Access and
 * Places.
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
  /** Sends it. Resolves `null` when it landed (the dialog closes), else the refusal to show. */
  onConfirm: (reason: string) => Promise<string | null>;
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
  onConfirm,
}: ReasonAskProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = reason.trim();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          setReason('');
          setRefusal(null);
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
          {refusal !== null && <AlertDialogError title="Not done.">{refusal}</AlertDialogError>}
          {extra}
          <AlertDialogReason
            label={label}
            placeholder={placeholder}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            waiting={(!optional && trimmed.length === 0) || busy}
            onClick={() => {
              setBusy(true);
              void onConfirm(trimmed).then(
                (refused) => {
                  setBusy(false);
                  if (refused === null) setOpen(false);
                  else setRefusal(refused);
                },
                // A sender that threw rather than answering: never a dialog stuck waiting.
                (err: unknown) => {
                  setBusy(false);
                  setRefusal(errorText(err));
                },
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
