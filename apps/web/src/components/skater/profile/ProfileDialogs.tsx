import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBan, faFlag } from '@fortawesome/sharp-light-svg-icons';
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
} from '../../kit/dialog';
import { Field, FieldLabel } from '../../kit/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../kit/select';
import { Textarea } from '../../kit/textarea';
import { FormLine } from '../auth/SystemStage';
import { INK_PRIMARY } from '../styles';

/**
 * Block (6.4) and Flag (6.5), over someone's profile: dialogs in component state, never the URL.
 * The block dialog says the thing a person blocking someone most needs to know — their ice reports
 * stay on the map (D3). Block is red (it takes something away); Flag is the ink primary.
 */

export type DialogState = 'idle' | 'busy' | 'failed';

export function BlockDialog({
  name,
  open,
  state,
  onOpenChange,
  onConfirm,
  container,
}: {
  name: string;
  open: boolean;
  state: DialogState;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  container?: HTMLElement | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={container} data-attr="profile-block-dialog">
        <DialogHeader>
          <DialogTitle className="ph-no-capture">Block {name}?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription className="text-fg1 text-row">
            You won’t see each other’s profiles or comments. Their ice reports stay on the map — a
            block never removes safety information. You can undo this in Settings.
          </DialogDescription>
          {state === 'failed' && <FormLine>The block didn’t go through. Try again.</FormLine>}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button />}>Cancel</DialogClose>
          <Button
            variant="danger"
            armed
            loading={state === 'busy'}
            onClick={onConfirm}
            data-attr="profile-block-confirm"
          >
            <FontAwesomeIcon icon={faBan} aria-hidden="true" />
            Block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The reasons a person can give, `unsafe_false_report` first — a false "ice is great" is a safety issue (D3). */
export const FLAG_REASONS = [
  { value: 'unsafe_false_report', label: 'Dangerously false ice reports' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'spam', label: 'Spam' },
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'other', label: 'Something else' },
] as const;

export type FlagReason = (typeof FLAG_REASONS)[number]['value'];

export function FlagDialog({
  open,
  state,
  onOpenChange,
  onSubmit,
  container,
}: {
  open: boolean;
  state: DialogState | 'sent';
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: FlagReason, note: string) => void;
  container?: HTMLElement | null;
}) {
  const [reason, setReason] = useState<FlagReason | null>(null);
  const [note, setNote] = useState('');
  const label = FLAG_REASONS.find((r) => r.value === reason)?.label;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={container} data-attr="profile-flag-dialog">
        <DialogHeader>
          <DialogTitle>Flag this profile</DialogTitle>
        </DialogHeader>
        {state === 'sent' ? (
          <>
            <DialogBody>
              <DialogDescription className="text-fg1 text-row">
                Thanks — a moderator will look at it. You’ll hear back when they’ve ruled.
              </DialogDescription>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (reason) onSubmit(reason, note.trim());
            }}
            className="contents"
          >
            <DialogBody className="gap-(--space-4)">
              <DialogDescription className="text-fg1 text-row">
                Reports of dangerously false ice conditions are treated as a safety issue.
              </DialogDescription>
              <Field>
                <FieldLabel>Reason</FieldLabel>
                <Select value={reason} onValueChange={(v) => setReason(v as FlagReason)}>
                  <SelectTrigger variant="boxed" aria-label="Reason" className="normal-case">
                    <SelectValue placeholder="Pick a reason">{label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent container={container}>
                    {FLAG_REASONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Note (optional)</FieldLabel>
                <Textarea
                  className="ph-no-capture"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add any context that helps a moderator."
                />
              </Field>
              {state === 'failed' && <FormLine>The flag didn’t go through. Try again.</FormLine>}
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button type="button" />}>Cancel</DialogClose>
              <Button
                type="submit"
                variant="primary"
                className={INK_PRIMARY}
                disabled={reason === null}
                loading={state === 'busy'}
                data-attr="profile-flag-submit"
              >
                <FontAwesomeIcon icon={faFlag} aria-hidden="true" />
                Submit flag
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
