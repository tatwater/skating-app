import { api } from '@skating/convex/api';
import { createFileRoute } from '@tanstack/react-router';
import { useAction, useConvexAuth, useMutation } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { Panel } from '../components/Panel';

/**
 * Where Google's consent returns for *From Google Photos* (A10-8 §8.6, D207). It opens in the
 * picker's own window, in the same browser as the Gli session, so it completes the pick **as the
 * signed-in person** — and a consent link someone else minted and forwarded is refused there
 * rather than landing the picks on their account. On success the window goes on to Google's
 * picker, which closes itself when the person is done; the page that opened it is polling and takes
 * it from there.
 */
export const Route = createFileRoute('/google-photos/callback')({
  component: GooglePhotosCallback,
});

const COPY = {
  opening: 'Opening Google Photos…',
  declined:
    "You didn't allow Gli to see the photos you pick, so nothing was added. You can close this window.",
  failed: "Couldn't open Google Photos. Close this window and try again from Gli.",
  signedOut: 'Sign in to Gli in this browser, then try again from the report.',
} as const;

function GooglePhotosCallback() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const complete = useAction(api.googlePhotos.complete);
  const abandon = useMutation(api.googlePhotos.abandon);
  const [message, setMessage] = useState<keyof typeof COPY>('opening');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || isLoading) return;
    ran.current = true;
    if (!isAuthenticated) {
      setMessage('signedOut');
      return;
    }
    const q = new URLSearchParams(window.location.search);
    const state = q.get('state');
    const code = q.get('code');
    if (!state) {
      setMessage('failed');
      return;
    }
    if (q.get('error') || !code) {
      void abandon({ state }).catch(() => undefined);
      setMessage(q.get('error') ? 'declined' : 'failed');
      return;
    }
    complete({ code, state })
      .then((outcome) => {
        if (outcome.ok) window.location.replace(outcome.pickerUri);
        else setMessage(outcome.reason);
      })
      .catch(() => setMessage('failed'));
  }, [isLoading, isAuthenticated, complete, abandon]);

  return (
    <main className="mx-auto max-w-md p-6">
      <Panel title="Google Photos">
        <p className="text-foreground text-sm" role="status">
          {COPY[message]}
        </p>
      </Panel>
    </main>
  );
}
