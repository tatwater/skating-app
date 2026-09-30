import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  CORPUS_NAME_DISMISS_LABELS,
  CORPUS_NAME_DISMISS_REASONS,
  type CorpusNameDismissReason,
} from '@skating/core';
import { useMutation } from 'convex/react';
import { type ReactElement, useState } from 'react';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { errorText } from './adminUi';
import { ReasonDialog } from './ReasonDialog';

/**
 * Dismiss a corpus place name (D202's queue): a reason from the short list, and a note if the
 * reason needs one. Shared by the triage page and the lake editor's Landmarks card.
 */
export function DismissPlaceNameDialog({
  id,
  name,
  trigger,
  onDone,
}: {
  id: Id<'corpusPlaceNames'>;
  name: string;
  trigger: ReactElement;
  onDone?: () => void;
}) {
  const dismiss = useMutation(api.corpusPlaceNames.dismiss);
  const [reason, setReason] = useState<CorpusNameDismissReason>('not_a_place');
  return (
    <ReasonDialog
      trigger={trigger}
      title={`Dismiss “${name}”`}
      description="It leaves the queue with this reason; the Dismissed tab can reopen it."
      confirmLabel="Dismiss"
      confirmVariant="secondary"
      requireReason={false}
      reasonPlaceholder="A note, if the reason needs one (optional)"
      extraFields={
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`dismiss-reason-${id}`}>Why it is not a landmark</Label>
          <Select
            value={reason}
            onValueChange={(v) => v && setReason(v as CorpusNameDismissReason)}
          >
            <SelectTrigger id={`dismiss-reason-${id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CORPUS_NAME_DISMISS_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {CORPUS_NAME_DISMISS_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
      onConfirm={async (note) => {
        try {
          await dismiss({ id, reason, ...(note ? { note } : {}) });
        } catch (err) {
          // The dialog shows `message`; give it the server's own sentence, not the transport's.
          throw new Error(errorText(err));
        }
        onDone?.();
      }}
    />
  );
}
