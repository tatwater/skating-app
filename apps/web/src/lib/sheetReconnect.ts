import { useEffect, useRef } from 'react';
import { resendSheet, type SheetSender, type SheetSendResult } from './sheetStore';
import { useConnection } from './useConnection';

/**
 * The caller `resendSheet` was built for (B03 §5, Review 3): on the way **into** online, send the
 * open sheet if it is waiting — a transient *Post* failure the author has not touched since. An edit
 * or a restore that lost a photo has already disarmed it in the store, so this never sends either.
 *
 * Only the transition fires it, never the state: a sheet opened while already online sends nothing
 * on mount, and a server that keeps failing transiently while online does not become a loop. Mount
 * it where the sheet is on screen, so a resend that lands is one the author sees land. Must render
 * under the Convex provider.
 */
export function useResendOnReconnect(
  send: SheetSender,
  onResult: (result: SheetSendResult) => void,
): void {
  const { status } = useConnection();
  const previous = useRef(status);
  // The latest closures, without the transition effect re-running when only they changed.
  const latest = useRef({ send, onResult });
  latest.current = { send, onResult };

  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status !== 'online' || was === 'online') return;
    void resendSheet((post, attempt) => latest.current.send(post, attempt)).then((result) => {
      if (result.kind !== 'skipped') latest.current.onResult(result);
    });
  }, [status]);
}
