import { type ReactNode, useRef, useState } from 'react';

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

import { WORDS } from './personWords';
import type { ActOutcome } from './useActing';

/**
 * The person page's one dialog: the kit reason dialog, asked before a write that needs something
 * the row can't hold — a reason (only when something is taken away), a duration, a limit.
 *
 * - **The write waits for the server.** Its button spins while the write is on its way (it stays
 *   mounted, so focus stays on it); on success the dialog closes and focus goes back to the row's
 *   button (Base UI's return focus). On refusal the dialog stays open over the kept reason — the
 *   server's words are a toast naming the person (D268), never printed here; a press that waited
 *   behind another change says the page's own note (`waitingNote`).
 * - **A reason is asked only when `reason` is set** — a give-back passes `reason={false}` and the
 *   dialog asks nothing but the choice in its body; `'optional'` offers the field without
 *   requiring it (the record sheet's Overturn: a give-back that may take one).
 * - `destructive` (a ban) takes two presses, the kit's armed step.
 */
export type AskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** The action's label ("Restrict"). */
  confirm: ReactNode;
  /** Ask a reason (a take-away); `'optional'` offers one without asking. */
  reason: boolean | 'optional';
  /** The reason field's kicker and placeholder, where the page words them its own way. */
  reasonLabel?: ReactNode;
  reasonPlaceholder?: string;
  /** The body's own choices (a duration, a limit), above the reason. */
  children?: ReactNode;
  /** Whatever the body chose is complete (a limit typed); the reason is checked here. */
  ready?: boolean;
  destructive?: boolean;
  /**
   * Runs the write with the reason typed (`''` when none is asked); resolves what it came to: the
   * dialog closes once it landed, and stays open otherwise.
   */
  onConfirm: (reason: string) => Promise<ActOutcome>;
  /** The page's note for a press that waited behind another change. */
  waitingNote?: ReactNode;
};

export function AskDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  reason,
  reasonLabel,
  reasonPlaceholder,
  children,
  ready = true,
  destructive = false,
  onConfirm,
  waitingNote = WORDS.anotherOnItsWay,
}: AskDialogProps) {
  // Esc and Cancel wait while the write is on its way: closed under it, a refusal would land with
  // nowhere to stand (the shell's undo dialog holds the same way).
  const busy = useRef(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy.current) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-slot="person-ask-dialog">
        {/* The popup's subtree unmounts while closed, so each opening starts clean. */}
        <AskBody
          title={title}
          description={description}
          confirm={confirm}
          reason={reason}
          {...(reasonLabel !== undefined && { reasonLabel })}
          {...(reasonPlaceholder !== undefined && { reasonPlaceholder })}
          ready={ready}
          destructive={destructive}
          onConfirm={onConfirm}
          waitingNote={waitingNote}
          onBusy={(b) => {
            busy.current = b;
          }}
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
  reasonLabel,
  reasonPlaceholder,
  ready,
  destructive,
  onConfirm,
  waitingNote,
  onBusy,
  onDone,
  children,
}: Omit<AskDialogProps, 'open' | 'onOpenChange'> & {
  onBusy: (busy: boolean) => void;
  onDone: () => void;
  ready: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // The page's own note, never a server's words: this press waited behind another change.
  const [waited, setWaited] = useState(false);
  const trimmed = text.trim();
  const waiting = !ready || (reason === true && trimmed.length === 0);
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogBody>
        {waited && <AlertDialogError>{waitingNote}</AlertDialogError>}
        {children}
        {reason !== false && (
          <AlertDialogReason
            label={reasonLabel ?? WORDS.reasonLabel}
            {...(reasonPlaceholder !== undefined && { placeholder: reasonPlaceholder })}
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
            onBusy(true);
            setWaited(false);
            void onConfirm(reason !== false ? trimmed : '').then((outcome) => {
              setBusy(false);
              onBusy(false);
              if (outcome === 'landed') onDone();
              else if (outcome === 'waiting') setWaited(true);
            });
          }}
        >
          {confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
