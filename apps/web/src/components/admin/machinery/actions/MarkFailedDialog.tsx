import { AUDIT_REASON_MAX } from '@skating/core';
import { useRef, useState } from 'react';

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
} from '@/components/kit/alert-dialog';

import { ACTION_WORDS as W } from '../words/runWords';

/**
 * ***Mark failed*'s question**: why — a reason is required (it is the record's *why*, kept on the
 * run and in the audit log), so the action waits until one is typed; ⌘⏎ confirms from anywhere in
 * the dialog (the kit's). The write waits for the server: on a landing the dialog closes; on a
 * refusal it stays open over the kept reason, and the server's words are a toast (D268), never
 * printed here. Esc and Cancel wait while the write is on its way.
 */
export function MarkFailedDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The run's name ("load", "a07a-20261012"). */
  title: string;
  /** Sends the mark with the reason typed; resolves whether it landed. */
  onConfirm: (reason: string) => Promise<boolean>;
}) {
  const busy = useRef(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy.current) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-slot="mark-failed-dialog">
        {/* The popup's subtree unmounts while closed, so each opening starts clean. */}
        <MarkFailedBody
          title={title}
          onConfirm={onConfirm}
          onBusy={(b) => {
            busy.current = b;
          }}
          onDone={() => onOpenChange(false)}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MarkFailedBody({
  title,
  onConfirm,
  onBusy,
  onDone,
}: {
  title: string;
  onConfirm: (reason: string) => Promise<boolean>;
  onBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const reason = text.trim();
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{W.dialogTitle(title)}</AlertDialogTitle>
        <AlertDialogDescription>{W.dialogBody}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogBody>
        <AlertDialogReason
          label={W.reasonLabel}
          placeholder={W.reasonPlaceholder}
          maxLength={AUDIT_REASON_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </AlertDialogBody>
      <AlertDialogFooter>
        <AlertDialogCancel />
        <AlertDialogAction
          waiting={reason.length === 0}
          loading={sending}
          onClick={() => {
            if (sending || reason.length === 0) return;
            setSending(true);
            onBusy(true);
            void onConfirm(reason).then((landed) => {
              setSending(false);
              onBusy(false);
              if (landed) onDone();
            });
          }}
        >
          {W.confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
