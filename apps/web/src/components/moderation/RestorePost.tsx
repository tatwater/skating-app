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
 * client never leaves a Post up with nothing in it; its refusal is shown in its own words.
 *
 * The view is pure (stories and tests drive it with props); `RestorePost` wires it to the server.
 */
export function RestorePostView({
  choices,
  onRestore,
}: {
  choices: PostRestoreChoices;
  /** Restore the Post, with these Reports when any are chosen. Resolves when the server answers. */
  onRestore: (reportIds: Id<'reports'>[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The server's refusal of the last attempt, verbatim; cleared by the next one, or by opening or
  // closing the chooser, so a stale refusal never sits under a fresh choice.
  const [error, setError] = useState<string | null>(null);

  const rows = choices.members.filter(
    (m) => m.standing === 'choose' || m.standing === 'author_deleted',
  );
  // Only what can still be chosen: the members are live, so a ticked Report someone else restored
  // in the meantime leaves the list, and must leave the choice and the count with it.
  const choosable = new Set<string>(
    rows.filter((m) => m.standing === 'choose').map((m) => m.reportId),
  );
  const picked = chosen.filter((id) => choosable.has(id));
  const count = picked.length;

  const restore = async (ids: Id<'reports'>[]) => {
    setBusy(true);
    setError(null);
    try {
      await onRestore(ids);
      setOpen(false);
      setChosen([]);
    } catch (err) {
      // Refused: say why in the server's words, and keep the choice as it was.
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const press = () => {
    if (choices.plainRestoreBringsBack) void restore([]);
    else {
      setError(null);
      setOpen(true);
    }
  };

  return (
    <>
      {/* A Post that is up already has nothing to restore: a press would only write a no-op row
          that overtakes the real restore's undo. */}
      <Button size="sm" onClick={press} disabled={busy || choices.postStatus === 'visible'}>
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
          setError(null);
          if (!next) setChosen([]);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this post</DialogTitle>
            <DialogDescription>{choices.prompt}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <CheckboxGroup value={picked} onValueChange={(value) => setChosen(value as string[])}>
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
                onClick={() => void restore(picked as Id<'reports'>[])}
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
  if (!choices) return null;
  return (
    <RestorePostView
      choices={choices}
      onRestore={async (reportIds) => {
        await setStatus({
          targetType: 'post',
          targetId: postId,
          status: 'visible',
          reason,
          ...(reportIds.length > 0 ? { withReportIds: reportIds } : {}),
        });
      }}
    />
  );
}
