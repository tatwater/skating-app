import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRightFromBracket } from '@fortawesome/sharp-light-svg-icons';
import { type PostDraft, type PostSheet, sheetLabel } from '@skating/core';

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

/**
 * Signing out with a report still unsent (7.15). The report sheet is a local draft from its first
 * keystroke (Review 3), and `useSignOut` forgets it — the author is leaving this browser and what
 * they wrote leaves with them. Today that happened without a word; now it asks first.
 */

/** The draft a sign-out would discard: which lake(s), and when it was started. */
export interface UnsentDraft {
  label: string;
  openedAtMs: number;
  /** `new`, or the report being edited — what `?post=` reopens. */
  post: string;
}

/**
 * Is there something a sign-out would lose? A sheet the author has written in (`dirty`), or one
 * with an attempt that hasn't gone out. A sheet opened and left untouched loses nothing worth
 * asking about; a saved, untouched sheet isn't dirty either.
 */
export function unsentDraft(
  sheet: PostSheet | null,
  attempt: PostDraft | null,
): UnsentDraft | null {
  if (sheet === null) return null;
  if (!sheet.dirty && attempt === null) return null;
  return {
    label: sheetLabel(sheet),
    openedAtMs: sheet.openedAtMs,
    post: sheet.mode.kind === 'edit' ? sheet.mode.reportId : 'new',
  };
}

/** "today at 11:52 AM", "yesterday at 4:05 PM", "on January 14 at 9:00 AM" — in the reader's zone. */
export function startedLabel(openedAtMs: number, now: number, timeZone?: string): string {
  const zone = timeZone ? { timeZone } : {};
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      ...zone,
    });
  const clock = new Date(openedAtMs).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...zone,
  });
  if (day(openedAtMs) === day(now)) return `today at ${clock}`;
  if (day(openedAtMs) === day(now - 86_400_000)) return `yesterday at ${clock}`;
  const date = new Date(openedAtMs).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    ...zone,
  });
  return `on ${date} at ${clock}`;
}

export interface SignOutDialogProps {
  draft: UnsentDraft | null;
  busy: boolean;
  /** For the "started …" words; the test pins it. */
  now?: number;
  onOpenChange: (open: boolean) => void;
  onSignOut: () => void;
  onOpenDraft: (draft: UnsentDraft) => void;
  container?: HTMLElement | null;
}

/** 7.15: the question, what is lost, and the way back to the draft. */
export function SignOutDialog({
  draft,
  busy,
  now,
  onOpenChange,
  onSignOut,
  onOpenDraft,
  container,
}: SignOutDialogProps) {
  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent container={container} data-attr="sign-out-guard">
        <DialogHeader>
          <DialogTitle>Sign out and discard your draft?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {draft !== null && (
            <DialogDescription className="ph-no-capture text-fg1 text-row">
              You have an unsent report on {draft.label}, started{' '}
              {startedLabel(draft.openedAtMs, now ?? Date.now())}. It lives only in this browser, so
              signing out discards it.
            </DialogDescription>
          )}
        </DialogBody>
        <DialogFooter
          note={
            <Button
              onClick={() => draft !== null && onOpenDraft(draft)}
              data-attr="sign-out-guard-open-draft"
            >
              Open the draft
            </Button>
          }
        >
          <DialogClose render={<Button />}>Cancel</DialogClose>
          <Button
            variant="danger"
            armed
            loading={busy}
            onClick={onSignOut}
            data-attr="sign-out-guard-confirm"
          >
            <FontAwesomeIcon icon={faArrowRightFromBracket} aria-hidden="true" />
            Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
