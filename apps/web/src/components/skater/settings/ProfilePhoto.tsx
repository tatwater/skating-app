import { useRef, useState } from 'react';

import { AVATAR_ACCEPT } from '@/lib/photo';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../kit/alert-dialog';
import { Avatar } from '../../kit/avatar';
import { Button } from '../../kit/button';

/** What the photo is doing: nothing, a new one going up, or the current one coming off. */
export type PhotoBusy = 'uploading' | 'removing' | null;

export interface ProfilePhotoProps {
  /** The person's name: the initials when there's no photo. */
  name: string;
  /** The photo on the account, or `undefined` for none. */
  imageUrl: string | undefined;
  busy: PhotoBusy;
  error: string | null;
  offline: boolean;
  onChange: (file: File) => void;
  /** Resolves `true` once the photo is gone, which closes the confirm. */
  onRemove: () => Promise<boolean>;
  /** Where the confirm portals to (a story's themed quad); the page's body otherwise. */
  container?: HTMLElement | null;
}

/**
 * The profile photo (7.4), props only: the circle as other skaters see it, Change photo (a file
 * pick) and, once there is one, Remove photo behind a confirm. Both wait while either is working,
 * and both wait while offline — a photo can't change without reaching Clerk. The photo sits inside
 * the section's masked region, so a session replay never shows it.
 */
export function ProfilePhoto({
  name,
  imageUrl,
  busy,
  error,
  offline,
  onChange,
  onRemove,
  container,
}: ProfilePhotoProps) {
  const input = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const inert = busy !== null || offline;
  return (
    <div className="flex items-center gap-(--space-5)">
      <Avatar
        name={name}
        src={imageUrl}
        aria-label="Your photo"
        aria-busy={busy !== null || undefined}
        className="size-[4rem] text-body"
      />
      <div className="flex min-w-0 flex-col gap-(--space-2)">
        <div className="flex items-center gap-(--space-3)">
          <Button
            size="sm"
            data-attr="settings-photo-change"
            loading={busy === 'uploading'}
            disabled={inert}
            onClick={() => input.current?.click()}
          >
            Change photo
          </Button>
          {imageUrl !== undefined && (
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
              <AlertDialogTrigger
                data-attr="settings-photo-remove"
                disabled={inert}
                render={<Button size="sm" variant="bare" />}
              >
                Remove photo
              </AlertDialogTrigger>
              <AlertDialogContent container={container}>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove your photo?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Your initials show in its place. You can add a photo again any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {error !== null && (
                  <AlertDialogBody>
                    <AlertDialogError title="Not removed.">{error}</AlertDialogError>
                  </AlertDialogBody>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel />
                  <AlertDialogAction
                    loading={busy === 'removing'}
                    disabled={offline}
                    onClick={async () => {
                      if (await onRemove()) setConfirming(false);
                    }}
                  >
                    Remove photo
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        {offline ? (
          <p className="m-0 text-assist text-fg3">
            You’re offline. Your photo can change once you’re back.
          </p>
        ) : error !== null && !confirming ? (
          <p role="alert" className="m-0 text-assist text-bad">
            {error}
          </p>
        ) : (
          <p className="m-0 text-assist text-fg3">JPEG, PNG, WebP, or HEIC.</p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={AVATAR_ACCEPT}
        hidden
        aria-label="Choose a photo"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onChange(file);
        }}
      />
    </div>
  );
}
