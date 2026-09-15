import { api } from '@skating/convex/api';
import type { Doc } from '@skating/convex/dataModel';
import { describePendingAccessReports, describePublicAccess } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';
import { Section } from './detailUi';
import { TextArea } from './ThemedInputs';

/**
 * "No public access" — the report control and the ruling it leads to (N6f), the mobile half of web's
 * `PublicAccessSection`.
 *
 * **The member's half only.** A moderator rules from the web queue (`/admin/flags`), where the
 * corroboration count is the rank and a dispute of a prior review is called out; there is no rule
 * button here. What the phone *does* need is the report, because the phone is where a skater is
 * standing when they get turned away — and until this section existed the mobile app carried the map
 * dim with nothing to press.
 *
 * ## Why an unconfirmed report is loud here and silent on the map
 *
 * A report shows on this sheet the moment it is filed — *"3 people have reported no public access
 * here — under review"* — and changes nothing on anyone else's map until a moderator rules. The
 * drawer is a page you opened about one lake, where an unverified claim is information; the map is a
 * shared surface where one account could otherwise dim any lake in the corpus. The one exception is
 * the reporter, who sees their own lake faded (`myAccessFlags` → the `selfFlagged` property).
 *
 * ## Why this never blocks anything
 *
 * A ruling dims the lake and demotes it. It does not hide the report form, the hazard form, or the
 * directions — the `AccessSection` invariant. Somebody with a key or a landowner's word is exactly
 * the person whose report is worth most.
 */
export function PublicAccessSection({ body }: { body: Doc<'waterBodies'> }) {
  const pending = useQuery(api.waterBodies.pendingAccessReportCount, { waterBodyId: body._id });
  const mine = useQuery(api.contentFlags.myAccessFlags, {});
  const report = useMutation(api.contentFlags.flag);

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verdict = body.publicAccess?.verdict;
  const settled = describePublicAccess(body.publicAccess);
  const count = pending ?? 0;
  const alreadyReported = (mine ?? []).includes(body._id);
  // A note is required only when a moderator has already ruled the body open — the gate is enforced
  // server-side; this is the courtesy that keeps a skater from discovering it via a round trip.
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

  // Nothing ruled, nobody reported, the form closed, and the viewer's own reports not yet known —
  // say nothing at all rather than flash a heading.
  if (!settled && count === 0 && !open && mine === undefined) return null;

  return (
    <Section label="Access">
      <YStack gap="$1.5">
        {verdict === 'none' ? (
          <Text color="$warning" fontWeight="600">
            {settled}
          </Text>
        ) : null}
        {verdict === 'open' ? <Text color="$foregroundMuted">{settled}</Text> : null}
        {body.publicAccess?.note ? (
          <Text color="$foregroundMuted" fontSize="$1">
            {body.publicAccess.note}
          </Text>
        ) : null}

        {/* Pending reports show only while unruled — once a moderator has answered, the count is
            history and the verdict is the answer. */}
        {!verdict && count > 0 ? (
          <Text color="$foregroundMuted">{describePendingAccessReports(count)}</Text>
        ) : null}

        {open ? (
          <YStack gap="$2">
            <TextArea
              value={note}
              onChangeText={setNote}
              placeholder={
                noteRequired
                  ? 'What changed since the review? (required)'
                  : 'How do you know? (optional)'
              }
              borderColor="$border"
            />
            {error ? (
              <Text color="$danger" fontSize="$1">
                {error}
              </Text>
            ) : null}
            <XStack gap="$2">
              <Button
                size="$2"
                backgroundColor="$primary"
                color="$primaryForeground"
                disabled={busy || (noteRequired && !note.trim())}
                onPress={() => void submit()}
              >
                {busy ? 'Sending…' : 'Send'}
              </Button>
              <Button size="$2" chromeless onPress={() => setOpen(false)}>
                Cancel
              </Button>
            </XStack>
          </YStack>
        ) : alreadyReported ? (
          // Their own claim, acknowledged. The dedup means a second tap would be a no-op anyway, so
          // saying so beats offering a button that does nothing.
          <Text color="$foregroundMuted" fontSize="$1">
            You reported this — it's with the moderators, and you'll see it faded on your map.
          </Text>
        ) : verdict === 'none' ? null : (
          <XStack>
            <Button size="$2" variant="outlined" onPress={() => setOpen(true)}>
              {count > 0 ? "Confirm — I've been turned away" : 'Report no public access'}
            </Button>
          </XStack>
        )}
      </YStack>
    </Section>
  );
}

/** Turn a thrown ConvexError into the line the server wrote — the gate message is written to be read. */
function errorText(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data?.message ?? 'That was rejected.');
  }
  return 'Something went wrong — check your connection and try again.';
}
