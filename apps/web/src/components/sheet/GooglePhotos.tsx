import { api } from '@skating/convex/api';
import type { DraftPhoto } from '@skating/core';
import { useAction, useMutation, useQuery } from 'convex/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextPickStep } from '../../lib/googlePhotosPoll';
import { addSheetPhoto, releaseSheetPhoto } from '../../lib/sheetPhotos';

type Phase = 'idle' | 'waiting' | 'adding';

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
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const run = useRef<{ state: string | null; win: Window | null; cancelled: boolean } | null>(null);

  const end = useCallback(
    (current: NonNullable<typeof run.current>) => {
      current.cancelled = true;
      if (current.win && !current.win.closed) current.win.close();
      if (current.state) void close({ state: current.state }).catch(() => undefined);
      if (run.current === current) run.current = null;
      setPhase('idle');
    },
    [close],
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
      if (current.cancelled) return;
      win.location.href = consentUrl;

      for (;;) {
        const step = nextPickStep(await status({ state }));
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
      for (const item of picked) {
        if (current.cancelled) break;
        const { bytes, mimeType } = await photo({ state, itemId: item.id });
        const draft = await addSheetPhoto(new File([bytes], item.filename, { type: mimeType }));
        // Google's capture time is the photo's; the bytes' own EXIF may have lost it.
        drafts.push(item.takenAtMs !== undefined ? { ...draft, takenAtMs: item.takenAtMs } : draft);
      }
      if (current.cancelled) release(drafts);
      else if (drafts.length > 0) onPhotos(drafts);
      end(current);
    } catch {
      // What was already processed holds blobs nobody will add; let them go.
      release(drafts);
      if (!current.cancelled) setError("Couldn't bring those photos over from Google Photos.");
      end(current);
    }
  }, [begin, status, list, photo, end, onPhotos]);

  const cancel = useCallback(() => {
    if (run.current) end(run.current);
  }, [end]);

  return { available, phase, error, start, cancel };
}

/** The pool's *From Google Photos* line: the button, or the wait with its *Cancel*. */
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
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
      {g.phase === 'idle' ? (
        <button
          type="button"
          onClick={() => void g.start()}
          disabled={disabled}
          className="rounded-[2px] border border-border px-2 py-1 text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          From Google Photos
        </button>
      ) : (
        <>
          <span className="text-foreground-muted" role="status">
            {g.phase === 'waiting' ? 'Waiting for Google Photos…' : 'Bringing your photos over…'}
          </span>
          <button
            type="button"
            onClick={g.cancel}
            className="text-foreground-muted underline hover:text-foreground"
          >
            Cancel
          </button>
        </>
      )}
      {g.error ? <span className="text-danger">{g.error}</span> : null}
      {g.phase === 'idle' && !g.error ? (
        <span className="text-foreground-muted">
          You pick in Google's window; only those photos come here. Needs a connection.
        </span>
      ) : null}
    </div>
  );
}
