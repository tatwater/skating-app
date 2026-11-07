import { api } from '@skating/convex/api';
import type { DraftPhoto } from '@skating/core';
import { useAction, useMutation, useQuery } from 'convex/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/kit/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { useAnalytics } from '@/lib/analytics';
import { nextPickStep } from '@/lib/googlePhotosPoll';
import { addSheetPhoto, releaseSheetPhoto } from '@/lib/sheetPhotos';
import { StatusSquare } from './SheetPanel';
import type { GooglePhotosSlotProps } from './sheetSlots';

export type Phase = 'idle' | 'waiting' | 'adding';

/** Failed looks in a row before the page gives the pick up, and the wait between them. */
const STATUS_MISSES = 6;
const STATUS_RETRY_MS = 5_000;

function release(drafts: readonly DraftPhoto[]): void {
  for (const d of drafts) releaseSheetPhoto(d.id);
}

/**
 * *From Google Photos* (A10-8 §8.6, D207): the person picks inside Google's own Photos Picker, in a
 * window of its own, and the picked photos arrive in the Post's pool like any other — their capture
 * time from Google, no location (Google strips it, so place-mode is how). Each use is its own
 * consent; nothing is kept at Google's side or ours once the add is done.
 *
 * The window opens **on the click**, before anything is awaited, or the browser's popup blocker
 * would take it; the consent URL arrives a moment later and the window is sent there. The page
 * never reads the window's state (Google's pages may sever it; see `googlePhotosPoll`): the pick
 * ends when the session does, or on *Cancel*.
 */
export function useGooglePhotos(onPhotos: (photos: DraftPhoto[]) => void) {
  const available = useQuery(api.googlePhotos.available, {}) === true;
  const begin = useMutation(api.googlePhotos.begin);
  const status = useAction(api.googlePhotos.status);
  const list = useAction(api.googlePhotos.list);
  const photo = useAction(api.googlePhotos.photo);
  const close = useAction(api.googlePhotos.close);
  const abandon = useMutation(api.googlePhotos.abandon);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const run = useRef<{ state: string | null; win: Window | null; cancelled: boolean } | null>(null);

  const end = useCallback(
    (current: NonNullable<typeof run.current>) => {
      current.cancelled = true;
      if (current.win && !current.win.closed) current.win.close();
      // Both halves: the session if Google's consent was given, the state if it was not yet.
      if (current.state) {
        void close({ state: current.state }).catch(() => undefined);
        void abandon({ state: current.state }).catch(() => undefined);
      }
      // A run that is no longer the current one leaves the page to the one that is.
      if (run.current === current) {
        run.current = null;
        setPhase('idle');
      }
    },
    [close, abandon],
  );

  // A page left mid-pick still deletes the session.
  useEffect(
    () => () => {
      if (run.current) end(run.current);
    },
    [end],
  );

  const start = useCallback(async () => {
    setError(null);
    const win = window.open('about:blank', 'gli-google-photos', 'popup,width=760,height=840');
    if (!win) {
      setError(
        'Your browser blocked the Google Photos window. Allow pop-ups for Gli and try again.',
      );
      return;
    }
    const current = { state: null as string | null, win, cancelled: false };
    run.current = current;
    const drafts: DraftPhoto[] = [];
    setPhase('waiting');
    try {
      const { state, consentUrl } = await begin({});
      current.state = state;
      // Cancelled while the state was being minted: `end` had nothing to spend then, so spend it now.
      if (current.cancelled) {
        void abandon({ state }).catch(() => undefined);
        return;
      }
      win.location.href = consentUrl;

      let misses = 0;
      for (;;) {
        // A look that fails on our side (a dropped connection) is not the end of a pick the person
        // is still making: look again, and give up only after a run of them.
        let seen: Awaited<ReturnType<typeof status>>;
        try {
          seen = await status({ state });
          misses = 0;
        } catch {
          if (current.cancelled) return;
          misses += 1;
          if (misses > STATUS_MISSES) throw new Error('lost the pick');
          await new Promise((resolve) => setTimeout(resolve, STATUS_RETRY_MS));
          continue;
        }
        const step = nextPickStep(seen);
        if (current.cancelled) return;
        if (step.kind === 'end') {
          setError('Google Photos closed without adding anything.');
          end(current);
          return;
        }
        if (step.kind === 'add') break;
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        if (current.cancelled) return;
      }

      setPhase('adding');
      const picked = await list({ state });
      let missed = 0;
      for (const item of picked) {
        if (current.cancelled) break;
        // Each photo on its own: one Google won't hand over, or that won't decode, costs itself.
        try {
          const { bytes, mimeType } = await photo({ state, itemId: item.id });
          const draft = await addSheetPhoto(new File([bytes], item.filename, { type: mimeType }));
          // Google's capture time is the photo's; the bytes' own EXIF may have lost it.
          drafts.push(
            item.takenAtMs !== undefined ? { ...draft, takenAtMs: item.takenAtMs } : draft,
          );
        } catch {
          missed += 1;
        }
      }
      if (current.cancelled) release(drafts);
      else {
        if (drafts.length > 0) onPhotos(drafts);
        if (missed > 0) {
          setError(
            missed === 1
              ? "One photo couldn't be brought over. The rest were added."
              : `${missed} photos couldn't be brought over. The rest were added.`,
          );
        }
      }
      end(current);
    } catch {
      // What was already processed holds blobs nobody will add; let them go.
      release(drafts);
      if (!current.cancelled) setError("Couldn't bring those photos over from Google Photos.");
      end(current);
    }
  }, [begin, status, list, photo, end, onPhotos, abandon]);

  const cancel = useCallback(() => {
    if (run.current) end(run.current);
  }, [end]);

  return { available, phase, error, start, cancel };
}

/**
 * *From Google Photos* (5.21), re-skinned: the button in the photo strip; once pressed, a line of
 * its own — the ice square, *Waiting for Google Photos…*, and *Cancel* at its end. What it would
 * have explained in a helper line is the button's tooltip.
 */
export function GooglePhotosButton({
  onPhotos,
  disabled,
}: {
  onPhotos: (photos: DraftPhoto[]) => void;
  disabled?: boolean;
}) {
  const g = useGooglePhotos(onPhotos);
  if (!g.available) return null;
  return (
    <GooglePhotosView
      phase={g.phase}
      error={g.error}
      {...(disabled !== undefined ? { disabled } : {})}
      onStart={() => void g.start()}
      onCancel={g.cancel}
    />
  );
}

/** What the button draws, Convex-free: idle, waiting on Google's window, or bringing photos over. */
export function GooglePhotosView({
  phase,
  error,
  disabled,
  onStart,
  onCancel,
}: {
  phase: Phase;
  error: string | null;
  disabled?: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      {phase === 'idle' ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="sm" data-attr="google-photos" disabled={disabled} onClick={onStart}>
                From Google Photos
              </Button>
            }
          />
          <TooltipContent>
            Pick photos in Google’s own window; only the ones you pick come here.
          </TooltipContent>
        </Tooltip>
      ) : (
        <div
          data-slot="google-photos-waiting"
          className="flex basis-full items-center gap-(--space-2_5) border border-solid border-line p-(--space-2_5)"
        >
          <StatusSquare state="ice" />
          <span role="status" className="font-(family-name:--family-mono) text-mono-sm text-fg1">
            {phase === 'waiting' ? 'Waiting for Google Photos…' : 'Bringing your photos over…'}
          </span>
          <Button size="sm" className="ml-auto" data-attr="google-photos-cancel" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="m-0 basis-full text-assist leading-body text-warn">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The `googlePhotos` slot: the button, and the count of what it brought, by source (D240). */
export function GooglePhotosSlot({ disabled, onPhotos }: GooglePhotosSlotProps) {
  const { capture } = useAnalytics();
  return (
    <GooglePhotosButton
      disabled={disabled}
      onPhotos={(drafts) => {
        onPhotos(drafts);
        capture('report_photos_added', { source: 'google_photos', count: drafts.length });
      }}
    />
  );
}
