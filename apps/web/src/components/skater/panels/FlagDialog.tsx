import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFlag } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import { useMutation } from 'convex/react';
import { useState } from 'react';

import { Button } from '../../kit/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../kit/dialog';
import { RadioGroup, RadioRow } from '../../kit/radio';
import { Textarea } from '../../kit/textarea';

/** Flag targets and reasons mirror the server's enums (`FLAG_TARGET_TYPES`, `FLAG_REASONS`). */
export type FlagTarget = 'report' | 'comment' | 'hazard';
export type FlagReason = 'unsafe_false_report' | 'spam' | 'harassment' | 'inappropriate' | 'other';

/** A dangerously false report leads: it's a safety issue (D3), the rest are manners. */
export const FLAG_REASONS: ReadonlyArray<{ value: FlagReason; label: string }> = [
  { value: 'unsafe_false_report', label: 'Dangerously false ice report' },
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'other', label: 'Other' },
];

export interface FlagDialogViewProps {
  target: FlagTarget;
  /** The trigger's words: "Flag" in a foot. */
  label?: string;
  onSubmit: (reason: FlagReason, note: string | undefined) => Promise<void>;
  /** Story quads keep the dialog inside themselves. */
  container?: HTMLElement | null;
  /** The trigger's size: `sm` in a foot, `xs` under a comment. */
  size?: 'sm' | 'xs';
}

/**
 * Flag something for a moderator (D32): a reason, an optional note, then "Thanks". The flag is
 * deduped server-side to one open flag per target per person, so a second flag is harmless.
 */
export function FlagDialogView({
  target,
  label = 'Flag',
  onSubmit,
  container,
  size = 'sm',
}: FlagDialogViewProps) {
  const [reason, setReason] = useState<FlagReason | null>(null);
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const send = async () => {
    if (reason === null) return;
    setState('sending');
    try {
      await onSubmit(reason, note.trim() === '' ? undefined : note.trim());
      setState('sent');
    } catch {
      setState('failed');
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) return;
        setReason(null);
        setNote('');
        setState('idle');
      }}
    >
      <DialogTrigger
        data-attr={`flag-${target}`}
        render={<Button size={size} className="text-fg2" />}
      >
        <FontAwesomeIcon icon={faFlag} aria-hidden="true" className="h-[0.8125rem]" />
        {label}
      </DialogTrigger>
      <DialogContent {...(container !== undefined ? { container } : {})}>
        <DialogHeader>
          <DialogTitle>Flag this {target}</DialogTitle>
          <DialogDescription>
            A moderator reads every flag. A dangerously false ice report is treated as a safety
            issue.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {state === 'sent' ? (
            <p className="m-0">Thanks. A moderator will review it.</p>
          ) : (
            <>
              <RadioGroup
                aria-label="Reason"
                value={reason}
                onValueChange={(value) => setReason(value as FlagReason)}
              >
                {FLAG_REASONS.map((r) => (
                  <RadioRow key={r.value} value={r.value} label={r.label} />
                ))}
              </RadioGroup>
              <Textarea
                aria-label="Note (optional)"
                placeholder="Anything that helps a moderator (optional)"
                value={note}
                onValueChange={(value) => setNote(value)}
              />
              {state === 'failed' && (
                <p role="alert" className="m-0 text-assist text-bad">
                  Not sent. Check your connection and try again.
                </p>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {state === 'sent' ? (
            <DialogClose render={<Button />}>Close</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <Button
                variant="primary"
                data-attr="flag-send"
                disabled={reason === null}
                loading={state === 'sending'}
                onClick={() => void send()}
              >
                Send
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The live flag: `contentFlags.flag`. */
export function FlagDialog({
  target,
  targetId,
  label,
  size,
}: {
  target: FlagTarget;
  targetId: string;
  label?: string;
  size?: 'sm' | 'xs';
}) {
  const flag = useMutation(api.contentFlags.flag);
  return (
    <FlagDialogView
      target={target}
      {...(label !== undefined ? { label } : {})}
      {...(size !== undefined ? { size } : {})}
      onSubmit={async (reason, note) => {
        await flag({
          targetType: target,
          targetId,
          reason,
          ...(note !== undefined ? { note } : {}),
        });
      }}
    />
  );
}
