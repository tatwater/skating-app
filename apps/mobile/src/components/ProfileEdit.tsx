import { api } from '@skating/convex/api'
import { BIO_MAX_LENGTH, isMinor, TOWN_LABEL_MAX_LENGTH } from '@skating/core'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { Button, Input, Paragraph, Text, TextArea, XStack, YStack } from 'tamagui'

/**
 * Edit the caller's own profile (D13) — bio, town, public↔private. The public toggle is disabled for
 * minors (D41) with explanatory copy. Reads `profiles.current`, saves via `updateProfile`.
 */
export function ProfileEdit() {
  const profile = useQuery(api.profiles.current, {})
  const updateProfile = useMutation(api.profiles.updateProfile)
  const [bio, setBio] = useState<string | null>(null)
  const [town, setTown] = useState<string | null>(null)
  const [isPublic, setIsPublic] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  if (!profile) return null

  const canGoPublic = !isMinor(profile.dateOfBirth, Date.now())
  // Controlled values fall back to the stored profile until the user edits them.
  const bioValue = bio ?? profile.bio ?? ''
  const townValue = town ?? profile.homeTownLabel ?? ''
  const publicValue = isPublic ?? profile.profileVisibility === 'public'

  return (
    <YStack gap="$3">
      <YStack gap="$1.5">
        <Text color="$foreground">Bio</Text>
        <TextArea
          value={bioValue}
          onChangeText={setBio}
          maxLength={BIO_MAX_LENGTH}
          placeholder="A short blurb — shown only on a public profile."
          borderColor="$border"
        />
      </YStack>
      <YStack gap="$1.5">
        <Text color="$foreground">Town</Text>
        <Input
          value={townValue}
          onChangeText={setTown}
          maxLength={TOWN_LABEL_MAX_LENGTH}
          placeholder="e.g. Norwich, VT"
          borderColor="$border"
        />
      </YStack>
      <YStack gap="$1.5">
        <XStack gap="$2">
          <Button
            size="$2"
            backgroundColor={publicValue ? '$primary' : undefined}
            color={publicValue ? '$primaryForeground' : undefined}
            disabled={!canGoPublic}
            onPress={() => setIsPublic(true)}
          >
            Public
          </Button>
          <Button
            size="$2"
            backgroundColor={!publicValue ? '$primary' : undefined}
            color={!publicValue ? '$primaryForeground' : undefined}
            onPress={() => setIsPublic(false)}
          >
            Private
          </Button>
        </XStack>
        <Paragraph color="$foregroundMuted" fontSize="$1">
          {canGoPublic
            ? 'A public profile is searchable and shows your town, bio, and report history. Private shows only your name and photo.'
            : 'Under-18 profiles stay private until you turn 18. Your reports are still public and help the community.'}
        </Paragraph>
      </YStack>
      {saved ? <Text color="$foregroundMuted">Saved.</Text> : null}
      <Button
        backgroundColor="$primary"
        color="$primaryForeground"
        disabled={saving}
        onPress={async () => {
          setSaving(true)
          setSaved(false)
          try {
            await updateProfile({
              bio: bioValue,
              homeTownLabel: townValue,
              profileVisibility: publicValue ? 'public' : 'private',
            })
            setSaved(true)
          } finally {
            setSaving(false)
          }
        }}
      >
        {saving ? 'Saving…' : 'Save profile'}
      </Button>
    </YStack>
  )
}
