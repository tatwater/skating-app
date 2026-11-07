import { useUser } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { useMutation } from 'convex/react';
import { useState } from 'react';

import { isAvatarImage } from '@/lib/photo';
import { useBrowserOnline } from '@/lib/useConnection';

import { processAvatar } from '../../photoPipeline';
import type { PhotoBusy } from './ProfilePhoto';

/** Clerk's message, or ours when it has none worth showing. */
function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface ProfilePhotoState {
  /** The photo on the account, or `undefined` for none (the initials show). */
  imageUrl: string | undefined;
  busy: PhotoBusy;
  error: string | null;
  offline: boolean;
  /** Shrink the picked file and hand it to Clerk. */
  onChange: (file: File) => Promise<void>;
  /** Clear the photo. Resolves `true` once it's gone, so the confirm can close. */
  onRemove: () => Promise<boolean>;
}

/**
 * The profile photo's state and Clerk's calls. **Clerk owns the photo**: `setProfileImage` writes
 * it, and Clerk's own `user` updates from the response, so the circle changes without a reload. The
 * profile's mirror (`profileImageUrl`, what other skaters see) follows the way every Clerk change
 * does — the `user.updated` webhook, ordered by Clerk's `updated_at` — and the nudge here is the
 * same `syncFromClerk` the shell sends on open, so there is no second write path.
 *
 * **Offline is refused up front.** Clerk's resource fetch resolves `null` instead of throwing when
 * the browser is offline, so a call made then would look like it worked and change nothing.
 */
export function useProfilePhoto(): ProfilePhotoState {
  const { user } = useUser();
  const online = useBrowserOnline();
  const syncFromClerk = useMutation(api.profiles.syncFromClerk);
  const [busy, setBusy] = useState<PhotoBusy>(null);
  const [error, setError] = useState<string | null>(null);

  const nudge = () => void syncFromClerk({}).catch(() => {});

  const onChange = async (file: File) => {
    if (!user || busy !== null || !online) return;
    setError(null);
    if (!isAvatarImage(file)) {
      setError('That file isn’t a photo we can use. Try a JPEG, PNG, WebP, or HEIC.');
      return;
    }
    setBusy('uploading');
    try {
      let processed: File;
      try {
        processed = await processAvatar(file);
      } catch {
        setError('That photo couldn’t be read. Try another, or save it as a JPEG first.');
        return;
      }
      try {
        await user.setProfileImage({ file: processed });
      } catch (e) {
        setError(message(e, 'Your photo wasn’t saved. Try again in a moment.'));
        return;
      }
      nudge();
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    if (!user || busy !== null || !online) return false;
    setError(null);
    setBusy('removing');
    try {
      await user.setProfileImage({ file: null });
      nudge();
      return true;
    } catch (e) {
      setError(message(e, 'Your photo wasn’t removed. Try again in a moment.'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return {
    imageUrl: user?.hasImage ? user.imageUrl : undefined,
    busy,
    error,
    offline: !online,
    onChange,
    onRemove,
  };
}
