import { type ReactNode, useState } from 'react';

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
} from '@/components/kit/alert-dialog';

/**
 * The person page's one dialog: the kit reason dialog, asked before a write that needs something
 * the row can't hold — a reason (only when something is taken away), a duration, a limit.
 *
 * - **The write waits for the server.** Its button spins while the write is on its way (it stays
 *   mounted, so focus stays on it); on success the dialog closes and focus goes back to the row's
 *   button (Base UI's return focus); on refusal the server's own words stand over the kept reason.
 * - **A reason is asked only when `reason` is set** — a give-back passes `reason={false}` and the
 *   dialog asks nothing but the choice in its body.
 * - `destructive` (a ban) takes two presses, the kit's armed step.
 */
export type AskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** The action's label ("Restrict"). */
  confirm: ReactNode;
  /** Ask a reason (a take-away). */
  reason: boolean;
  /** The body's own choices (a duration, a limit), above the reason. */
  children?: ReactNode;
  /** Whatever the body chose is complete (a limit typed); the reason is checked here. */
  ready?: boolean;
  destructive?: boolean;
  /**
   * Runs the write with the reason typed (`''` when none is asked); resolves to the server's
   * refusal, or `null` when it landed.
   */
  onConfirm: (reason: string) => Promise<string | null>;
};

export function AskDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  reason,
  children,
  ready = true,
  destructive = false,
  onConfirm,
}: AskDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-slot="person-ask-dialog">
        {/* The popup's subtree unmounts while closed, so each opening starts clean. */}
        <AskBody
          title={title}
          description={description}
          confirm={confirm}
          reason={reason}
          ready={ready}
          destructive={destructive}
          onConfirm={onConfirm}
          onDone={() => onOpenChange(false)}
        >
          {children}
        </AskBody>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The open dialog's state — mounted fresh each time it opens, so nothing carries over. */
function AskBody({
  title,
  description,
  confirm,
  reason,
  ready,
  destructive,
  onConfirm,
  onDone,
  children,
}: Omit<AskDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void; ready: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const trimmed = text.trim();
  const waiting = !ready || (reason && trimmed.length === 0);
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogBody>
        {refusal !== null && <AlertDialogError>{refusal}</AlertDialogError>}
        {children}
        {reason && (
          <AlertDialogReason
            label="Reason · kept in the audit log"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </AlertDialogBody>
      <AlertDialogFooter>
        <AlertDialogCancel />
        <AlertDialogAction
          destructive={destructive}
          waiting={waiting}
          loading={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            void onConfirm(reason ? trimmed : '').then((refused) => {
              setBusy(false);
              if (refused === null) onDone();
              else setRefusal(refused);
            });
          }}
        >
          {confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
