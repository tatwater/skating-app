import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { errorText } from '@/components/admin/adminUi';
import { Button } from '@/components/kit/button';
import { CheckboxGroup, CheckboxRow } from '@/components/kit/checkbox';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/kit/dialog';

/** What `moderation.postRestoreChoices` returns for a Post that exists. */
export type PostRestoreChoices = NonNullable<
  FunctionReturnType<typeof api.moderation.postRestoreChoices>
>;
type Member = PostRestoreChoices['members'][number];

/** The server's own wording, kept here only for the case it can't be asked (nothing restorable). */
const NEEDS_A_CHOICE =
  'Every report in this post was hidden or removed on its own. Choose at least one report to restore with it.';
const UNRESTORABLE =
  "Every report in this post was deleted by its author, so the post can't be restored.";

const VERB: Record<string, string> = {
  hide: 'Hidden',
  remove: 'Removed',
  author_delete: 'Deleted by its author',
};

function day(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "Lake Morey · Jan 14, 2027" — what the Report is. */
function memberLabel(m: Member): string {
  return `${m.waterBodyName ?? 'A water body no longer listed'} · ${day(m.skateEndTime)}`;
}

/** "Removed by @mod on Jan 15, 2027 — doxxing" — why it is down. */
function whyDown(m: Member): string {
  if (m.standing === 'author_deleted') {
    return `Deleted by its author on ${day(m.down?.at ?? m.skateEndTime)}, so it can't come back with the post.`;
  }
  if (!m.down) return '';
  const verb = VERB[m.down.action] ?? 'Taken down';
  const who = m.down.by ? ` by @${m.down.by.username}` : '';
  return `${verb}${who} on ${day(m.down.at)} — ${m.down.reason}`;
}

/**
 * Restore a Post, choosing Reports to bring back with it when a plain restore would show none
 * (founder call, 2026-11-13). Pressing Restore restores at once when at least one Report comes back
 * with the Post on its own; otherwise it opens a checklist of the Post's Reports — what each is and
 * why it is down — with **nothing pre-selected** (each takedown was a decision; bringing one back
 * is a conscious override), Reports their author deleted shown but not choosable, and the confirm
 * carrying the count. The server refuses an empty restore whatever this shows, so a race or another
 * client never leaves a Post up with nothing in it.
 *
 * The view is pure (stories and tests drive it with props); `RestorePost` wires it to the server.
 */
export function RestorePostView({
  choices,
  onRestore,
  error,
}: {
  choices: PostRestoreChoices;
  /** Restore the Post, with these Reports when any are chosen. Resolves when the server answers. */
  onRestore: (reportIds: Id<'reports'>[]) => Promise<void>;
  /** The server's refusal, verbatim, when a restore was turned down. */
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const restore = async (ids: Id<'reports'>[]) => {
    setBusy(true);
    try {
      await onRestore(ids);
      setOpen(false);
      setChosen([]);
    } catch {
      // Refused: the caller shows the server's words (`error`), and the choice stays as it was.
    } finally {
      setBusy(false);
    }
  };

  const press = () => {
    if (choices.plainRestoreBringsBack) void restore([]);
    else setOpen(true);
  };

  const rows = choices.members.filter(
    (m) => m.standing === 'choose' || m.standing === 'author_deleted',
  );
  const count = chosen.length;

  return (
    <>
      <Button size="sm" onClick={press} disabled={busy}>
        Restore post
      </Button>
      {error && !open ? (
        <p role="alert" className="text-assist text-bad">
          {error}
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setChosen([]);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this post</DialogTitle>
            <DialogDescription>
              {choices.restorable ? NEEDS_A_CHOICE : UNRESTORABLE}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <CheckboxGroup value={chosen} onValueChange={(value) => setChosen(value as string[])}>
              {rows.map((m) => (
                <CheckboxRow
                  key={m.reportId}
                  name="report"
                  value={m.reportId}
                  disabled={m.standing !== 'choose'}
                  label={memberLabel(m)}
                  description={whyDown(m)}
                />
              ))}
            </CheckboxGroup>
            {error ? (
              <p role="alert" className="text-assist text-bad">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button size="sm" />}>
              {choices.restorable ? 'Cancel' : 'Close'}
            </DialogClose>
            {choices.restorable ? (
              <Button
                size="sm"
                variant="primary"
                disabled={count === 0 || busy}
                onClick={() => void restore(chosen as Id<'reports'>[])}
              >
                {`Restore with ${count} ${count === 1 ? 'report' : 'reports'}`}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The connected chooser, mountable anywhere a moderator restores a Post (the console's People
 * hidden-content sheet and the Inbox will). `reason` is the moderator's, collected by the caller —
 * a restore is audited like every verdict.
 */
export function RestorePost({ postId, reason }: { postId: Id<'posts'>; reason: string }) {
  const choices = useQuery(api.moderation.postRestoreChoices, { postId });
  const setStatus = useMutation(api.moderation.setModerationStatus);
  const [error, setError] = useState<string | null>(null);
  if (!choices) return null;
  return (
    <RestorePostView
      choices={choices}
      error={error}
      onRestore={async (reportIds) => {
        setError(null);
        try {
          await setStatus({
            targetType: 'post',
            targetId: postId,
            status: 'visible',
            reason,
            ...(reportIds.length > 0 ? { withReportIds: reportIds } : {}),
          });
        } catch (err) {
          setError(errorText(err));
          throw err;
        }
      }}
    />
  );
}
