import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';

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
  /**
   * Sends it. Resolves `null` when it landed (the dialog closes), else the refusal to show. `asker`
   * is this opening of the dialog: there until it closes or the dialog goes, so an answer that comes
   * later is said by someone still there, never into a dialog that has gone.
   */
  onConfirm: (reason: string, asker: { here: () => boolean }) => Promise<string | null>;
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
  // This opening of the dialog: a send's answer acts only on the opening that sent it. The dialog
  // going (its page left) ends every opening.
  const opening = useRef(0);
  useEffect(
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
          {/* A sent reason is held while its write is out: the dialog closes when it lands, so
              words typed then could never be sent — the field takes none. */}
          <AlertDialogReason
            label={label}
            placeholder={placeholder}
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
              const current = () => opening.current === mine;
              void onConfirm(trimmed, { here: current }).then(
                (refused) => {
                  setBusy(false);
                  if (!current()) return;
                  if (refused === null) setOpen(false);
                  else setRefusal(refused);
                },
                // A sender that threw rather than answering: never a dialog stuck waiting.
                (err: unknown) => {
                  setBusy(false);
                  if (current()) setRefusal(errorText(err));
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
