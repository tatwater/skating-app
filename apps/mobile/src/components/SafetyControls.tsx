import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { Button, Text, TextArea, XStack, YStack } from 'tamagui'
import { Badge } from './detailUi'

/** Flag targets + reasons mirror the backend enums (`FLAG_TARGET_TYPES` / `FLAG_REASONS`). */
export type FlagTargetType = 'report' | 'comment' | 'photo' | 'user'

/** `unsafe_false_report` leads — a dangerously false "ice is great" claim is a safety issue (D3). */
const REASONS: { value: string; label: string }[] = [
  { value: 'unsafe_false_report', label: 'Dangerously false ice report' },
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'other', label: 'Other' },
]

/** A blocked author's report stays visible (safety, D3); the line carries this muted chip. */
export function BlockedChip() {
  return <Badge>Blocked</Badge>
}

/**
 * Flag content for abuse (D32) — an inline reason picker (incl. the first-class
 * `unsafe_false_report`, D3) + optional note, submitted to `contentFlags.flag`. Deduped server-side
 * to one open flag per target.
 */
export function FlagControl({
  targetType,
  targetId,
  label = 'Flag',
}: {
  targetType: FlagTargetType
  targetId: string
  label?: string
}) {
  const flag = useMutation(api.contentFlags.flag)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)

  if (submitted) {
    return <Text color="$foregroundMuted">Flag submitted — a moderator will review it.</Text>
  }

  if (!open) {
    return (
      <Button size="$2" chromeless onPress={() => setOpen(true)}>
        {label}
      </Button>
    )
  }

  return (
    <YStack
      gap="$2"
      padding="$2"
      borderColor="$border"
      borderWidth={1}
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
    >
      <Text color="$foreground">Why are you flagging this {targetType}?</Text>
      <YStack gap="$1.5">
        {REASONS.map((r) => (
          <Button
            key={r.value}
            size="$2"
            backgroundColor={reason === r.value ? '$primary' : undefined}
            color={reason === r.value ? '$primaryForeground' : undefined}
            onPress={() => setReason(r.value)}
          >
            {r.label}
          </Button>
        ))}
      </YStack>
      <TextArea
        value={note}
        onChangeText={setNote}
        placeholder="Add context (optional)"
        borderColor="$border"
      />
      <XStack gap="$2">
        <Button
          size="$2"
          backgroundColor="$primary"
          color="$primaryForeground"
          disabled={!reason}
          onPress={async () => {
            if (!reason) return
            await flag({
              targetType,
              targetId,
              reason: reason as 'unsafe_false_report',
              ...(note.trim() ? { note: note.trim() } : {}),
            })
            setSubmitted(true)
          }}
        >
          Submit
        </Button>
        <Button size="$2" chromeless onPress={() => setOpen(false)}>
          Cancel
        </Button>
      </XStack>
    </YStack>
  )
}

/**
 * Block a user (D32) — hides profiles + comments both ways, never their reports (D3). An inline
 * confirm explains that; on success the profile query re-runs and the profile becomes not-found
 * (unblock lives in the You tab → Blocked users).
 */
export function BlockButton({
  targetUserId,
  displayName,
}: {
  targetUserId: string
  displayName: string
}) {
  const block = useMutation(api.blocks.block)
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <Button size="$2" onPress={() => setConfirming(true)}>
        Block
      </Button>
    )
  }

  return (
    <YStack
      gap="$2"
      padding="$2"
      borderColor="$border"
      borderWidth={1}
      borderRadius="$4"
      backgroundColor="$surfaceMuted"
    >
      <Text color="$foreground">
        Block {displayName}? You won’t see each other’s profiles or comments. Their ice reports stay
        on the map.
      </Text>
      <XStack gap="$2">
        <Button
          size="$2"
          backgroundColor="$danger"
          color="$dangerForeground"
          onPress={() => block({ targetUserId: targetUserId as Id<'profiles'> })}
        >
          Block
        </Button>
        <Button size="$2" chromeless onPress={() => setConfirming(false)}>
          Cancel
        </Button>
      </XStack>
    </YStack>
  )
}
