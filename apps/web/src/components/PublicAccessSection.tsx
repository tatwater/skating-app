import { api } from '@skating/convex/api';
import type { Doc, Id } from '@skating/convex/dataModel';
import { describePendingAccessReports, describePublicAccess } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { useRole } from '../lib/useRole';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

/**
 * "No public access" — the report control and all three states of the ruling (N6f).
 *
 * ## Why an unconfirmed report is loud here and silent on the map
 *
 * A report shows on this panel the moment it is filed — *"3 people have reported no public access
 * here — under review"* — and changes nothing on anyone else's map until a moderator rules. The
 * asymmetry is deliberate. The drawer is a page you opened about one lake, where an unverified claim
 * is information; the map is a shared surface where a single account could otherwise dim any lake in
 * the corpus and nobody would know why. The one exception is the reporter themselves, who sees their
 * own lake faded — their claim, reflected back, reaching nobody.
 *
 * ## Why this never blocks anything
 *
 * A ruling dims the lake and demotes it. It does not hide the report form, the hazard form, or the
 * directions — the `AccessSection` invariant. Somebody with a key, an invitation, or a landowner's
 * word is exactly the person whose report is worth most, and a ruling we got wrong is only ever
 * corrected by someone who went anyway.
 */
export function PublicAccessSection({ body }: { body: Doc<'waterBodies'> }) {
  // One control, role-dependent effect: a member's tap files a report, a moderator's rules directly.
  const { canModerate } = useRole();
  const pending = useQuery(api.waterBodies.pendingAccessReportCount, { waterBodyId: body._id });
  const mine = useQuery(api.contentFlags.myAccessFlags, {});
  const report = useMutation(api.contentFlags.flag);
  const rule = useMutation(api.waterBodies.setPublicAccess);

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verdict = body.publicAccess?.verdict;
  const settled = describePublicAccess(body.publicAccess);
  const count = pending ?? 0;
  const alreadyReported = (mine ?? []).includes(body._id);
  // A note is required only when a moderator has already ruled the body open — the gate is enforced
  // server-side; this is the courtesy that keeps an operator from discovering it via a round trip.
  const noteRequired = verdict === 'open';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await report({
        targetType: 'waterbody',
        targetId: body._id,
        reason: 'no_public_access',
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setOpen(false);
      setNote('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // Nothing ruled, nobody reported, and no way to report (signed out) — say nothing at all.
  if (!settled && count === 0 && !open && !canModerate && mine === undefined) return null;

  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">Access</h3>

      {verdict === 'none' ? (
        <p className="font-medium text-amber-700 text-sm dark:text-amber-400">{settled}</p>
      ) : null}
      {verdict === 'open' ? <p className="text-foreground-muted text-sm">{settled}</p> : null}
      {body.publicAccess?.note ? (
        <p className="text-foreground-muted text-xs">{body.publicAccess.note}</p>
      ) : null}

      {/* Pending reports show only while unruled — once a moderator has answered, the count is
          history and the verdict is the answer. */}
      {!verdict && count > 0 ? (
        <p className="text-foreground-muted text-sm">{describePendingAccessReports(count)}</p>
      ) : null}

      {open ? (
        <div className="mt-1 flex flex-col gap-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={
              noteRequired
                ? 'What changed since the review? (required)'
                : 'How do you know? (optional)'
            }
          />
          {error ? <p className="text-danger text-xs">{error}</p> : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || (noteRequired && !note.trim())}
              onClick={() => void submit()}
            >
              {busy ? 'Sending…' : 'Send'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-2">
          {canModerate ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || verdict === 'none'}
                onClick={() => void ruleAs('none')}
              >
                Mark no public access
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || verdict === 'open'}
                onClick={() => void ruleAs('open')}
              >
                Confirm public access
              </Button>
              {verdict ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void ruleAs(null)}
                >
                  Clear
                </Button>
              ) : null}
            </>
          ) : alreadyReported ? (
            // Their own claim, acknowledged. The dedup means a second tap would be a no-op anyway,
            // so saying so beats offering a button that does nothing.
            <p className="text-foreground-muted text-xs">
              You reported this — it's with the moderators, and you'll see it faded on your map.
            </p>
          ) : verdict === 'none' ? null : (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {count > 0 ? "Confirm — I've been turned away" : 'Report no public access'}
            </Button>
          )}
        </div>
      )}
    </div>
  );

  async function ruleAs(next: 'none' | 'open' | null) {
    setBusy(true);
    setError(null);
    try {
      await rule({ waterBodyId: body._id as Id<'waterBodies'>, verdict: next });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
}

/** Turn a thrown ConvexError into the line the server wrote — the gate message is written to be read. */
function errorText(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data?.message ?? 'That was rejected.');
  }
  return 'Something went wrong — check your connection and try again.';
}
