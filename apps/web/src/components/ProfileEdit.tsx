import { api } from '@skating/convex/api';
import { BIO_MAX_LENGTH, isMinor, TOWN_LABEL_MAX_LENGTH } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

/** Editable profile values (D13). */
export interface ProfileEditValues {
  bio: string;
  homeTownLabel: string;
  isPublic: boolean;
}

/**
 * Presentational profile editor (D13) — bio, town label, public↔private. The public toggle is
 * **disabled for minors** (D41) with explanatory copy; they stay private. Convex-free so it's
 * unit-testable; the container below wires `updateProfile`.
 */
export function ProfileEditForm({
  initial,
  canGoPublic,
  onSave,
  saving = false,
  error,
  saved = false,
}: {
  initial: ProfileEditValues;
  canGoPublic: boolean;
  onSave: (values: ProfileEditValues) => void;
  saving?: boolean;
  error?: string | null;
  saved?: boolean;
}) {
  const [bio, setBio] = useState(initial.bio);
  const [homeTownLabel, setHomeTownLabel] = useState(initial.homeTownLabel);
  // A minor is forced private regardless of the stored value.
  const [isPublic, setIsPublic] = useState(canGoPublic && initial.isPublic);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-bio">Bio</Label>
          <Textarea
            id="edit-bio"
            value={bio}
            maxLength={BIO_MAX_LENGTH}
            onChange={(e) => setBio(e.target.value)}
            placeholder="A short blurb — shown only on a public profile."
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-town">Town</Label>
          <Input
            id="edit-town"
            value={homeTownLabel}
            maxLength={TOWN_LABEL_MAX_LENGTH}
            onChange={(e) => setHomeTownLabel(e.target.value)}
            placeholder="e.g. Norwich, VT"
          />
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="edit-public"
            checked={isPublic}
            disabled={!canGoPublic}
            onCheckedChange={(v) => setIsPublic(v === true)}
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="edit-public">Public profile</Label>
            <p className="text-foreground-muted text-xs">
              {canGoPublic
                ? 'A public profile is searchable and shows your town, bio, and report history. Private shows only your name and photo.'
                : 'Under-18 profiles stay private until you turn 18. Your reports are still public and help the community.'}
            </p>
          </div>
        </div>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        {saved ? <p className="text-foreground-muted text-sm">Saved.</p> : null}
        <div>
          <Button onClick={() => onSave({ bio, homeTownLabel, isPublic })} disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Container: reads the caller's own profile and saves edits via `updateProfile`. */
export function ProfileEdit() {
  const profile = useQuery(api.profiles.current, {});
  const updateProfile = useMutation(api.profiles.updateProfile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (profile === undefined) return null;
  if (profile === null) return null;

  const canGoPublic = !isMinor(profile.dateOfBirth, Date.now());

  return (
    <ProfileEditForm
      initial={{
        bio: profile.bio ?? '',
        homeTownLabel: profile.homeTownLabel ?? '',
        isPublic: profile.profileVisibility === 'public',
      }}
      canGoPublic={canGoPublic}
      saving={saving}
      saved={saved}
      error={error}
      onSave={async (values) => {
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
          await updateProfile({
            bio: values.bio,
            homeTownLabel: values.homeTownLabel,
            profileVisibility: values.isPublic ? 'public' : 'private',
          });
          setSaved(true);
        } catch {
          setError('Could not save your profile. Please try again.');
        } finally {
          setSaving(false);
        }
      }}
    />
  );
}
