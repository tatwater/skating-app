import { api } from '@skating/convex/api';
import { isLeaving } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Button, Text, TextArea, XStack, YStack } from 'tamagui';

/** Whether the current user is at least a moderator (D37). Read-only chrome only — see below. */
export function useIsModerator(): boolean {
  const profile = useQuery(api.profiles.current, {});
  return profile?.role === 'moderator' || profile?.role === 'admin';
}

/**
 * Whether the current user may take a moderator **action** — the role, and not being mid-deletion.
 *
 * Mirrors the server's `requireRole` / `requireContributorRole` split: a departing operator keeps
 * privileged *reads* and loses every privileged *write*, so a control that submits has to ask this
 * rather than {@link useIsModerator}. Otherwise the app offers a takedown button that the server now
 * refuses, which is the failure the "hide exactly what the server blocks" rule exists to prevent.
 */
export function useCanModerate(): boolean {
  const profile = useQuery(api.profiles.current, {});
  const hasRole = profile?.role === 'moderator' || profile?.role === 'admin';
  return hasRole && !isLeaving(profile);
}

/**
 * Role-gated inline moderator takedown (D32/D37) — hide/remove a visible report/comment with a
 * required reason (audited). Renders nothing for non-moderators. The full queue + restore live in
 * Phase 7's `/admin`.
 */
export function ModeratorActions({
  targetType,
  targetId,
}: {
  targetType: 'report' | 'comment';
  targetId: string;
}) {
  const canModerate = useCanModerate();
  const setStatus = useMutation(api.moderation.setModerationStatus);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  // The action gate, not the chrome gate — see `useCanModerate`.
  if (!canModerate) return null;

  if (!open) {
    return (
      <Button size="$2" chromeless onPress={() => setOpen(true)}>
        Moderate
      </Button>
    );
  }

  const act = async (status: 'hidden' | 'removed') => {
    if (!reason.trim()) return;
    await setStatus({ targetType, targetId, status, reason: reason.trim() });
    setOpen(false);
    setReason('');
  };

  return (
    <YStack
      gap="$2"
      padding="$2"
      borderColor="$border"
      borderWidth={1}
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
    >
      <Text color="$foreground">Reason (required)</Text>
      <TextArea
        value={reason}
        onChangeText={setReason}
        placeholder="Why is this being taken down?"
        borderColor="$border"
      />
      <XStack gap="$2">
        <Button size="$2" disabled={!reason.trim()} onPress={() => act('hidden')}>
          Hide
        </Button>
        <Button
          size="$2"
          backgroundColor="$danger"
          color="$dangerForeground"
          disabled={!reason.trim()}
          onPress={() => act('removed')}
        >
          Remove
        </Button>
        <Button size="$2" chromeless onPress={() => setOpen(false)}>
          Cancel
        </Button>
      </XStack>
    </YStack>
  );
}
