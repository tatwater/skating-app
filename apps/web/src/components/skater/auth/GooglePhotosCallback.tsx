import { api } from '@skating/convex/api';
import { useAction, useConvexAuth, useMutation } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../kit/button';
import { CellLoader } from '../../kit/meter';
import { SectionSlug } from '../../kit/section-slug';

const COPY = {
  opening: 'Opening Google Photos…',
  declined:
    'You didn’t allow Gli to see the photos you pick, so nothing was added. You can close this window.',
  failed: 'Couldn’t open Google Photos. Close this window and try again from Gli.',
  signedOut: 'Sign in to Gli in this browser, then try again from the report.',
} as const;

export type GooglePhotosState = keyof typeof COPY;

/**
 * The pop-up's four states (8.9), in the small window Google's consent returned to: no shell, no
 * region, the app's own register. It's a window of its own, so it states the surface itself.
 */
export function GooglePhotosStatus({ state }: { state: GooglePhotosState }) {
  return (
    <main
      data-surface="skater"
      className="flex min-h-dvh flex-col gap-[1rem] bg-bg px-[1.375rem] pt-[1.375rem] pb-[1.5rem] font-(family-name:--family-sans) text-fg"
    >
      <SectionSlug title="Google Photos" />
      <p role="status" className="text-fg text-pretty text-row leading-[1.5]">
        {COPY[state]}
      </p>
      {state === 'opening' ? (
        <CellLoader label="Opening Google Photos" className="self-start" />
      ) : (
        <Button size="sm" className="self-start" onClick={() => window.close()}>
          Close this window
        </Button>
      )}
    </main>
  );
}

/**
 * Where Google's consent returns for *From Google Photos* (A10-8 §8.6, D207). It opens in the
 * picker's own window, in the same browser as the Gli session, so it completes the pick **as the
 * signed-in person** — and a consent link someone else minted and forwarded is refused there
 * rather than landing the picks on their account. On success the window goes on to Google's
 * picker, which closes itself when the person is done; the page that opened it is polling and takes
 * it from there.
 */
export function GooglePhotosCallback() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const complete = useAction(api.googlePhotos.complete);
  const abandon = useMutation(api.googlePhotos.abandon);
  const [state, setState] = useState<GooglePhotosState>('opening');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || isLoading) return;
    ran.current = true;
    if (!isAuthenticated) {
      setState('signedOut');
      return;
    }
    const q = new URLSearchParams(window.location.search);
    const oauthState = q.get('state');
    const code = q.get('code');
    if (!oauthState) {
      setState('failed');
      return;
    }
    if (q.get('error') || !code) {
      void abandon({ state: oauthState }).catch(() => undefined);
      setState(q.get('error') ? 'declined' : 'failed');
      return;
    }
    complete({ code, state: oauthState })
      .then((outcome) => {
        if (outcome.ok) window.location.replace(outcome.pickerUri);
        else setState(outcome.reason);
      })
      .catch(() => setState('failed'));
  }, [isLoading, isAuthenticated, complete, abandon]);

  return <GooglePhotosStatus state={state} />;
}
