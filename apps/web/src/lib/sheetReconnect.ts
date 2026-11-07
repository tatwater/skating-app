import { useEffect, useRef } from 'react';
import { getSheet, resendSheet, type SheetSender, type SheetSendResult } from './sheetStore';
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
 *
 * A result is handed on only while it is still about what is on screen: if the host had unmounted
 * by the time the answer came back (the author left the console), or the sheet that went is no
 * longer the open one (closed, replaced, another account's), the answer is dropped — the store has
 * already settled that sheet, and acting on it would clear or navigate away from whatever the author
 * has open now. "By the time the answer came back" is read before the store takes it: a Post that
 * lands closes the sheet, and the host unmounting for that reason must not swallow its own answer.
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

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status !== 'online' || was === 'online') return;
    let sent: string | null = null;
    let liveAtAnswer = false;
    void resendSheet(async (post, attempt) => {
      sent = post.draftId;
      try {
        return await latest.current.send(post, attempt);
      } finally {
        liveAtAnswer = mounted.current;
      }
    }).then((result) => {
      if (result.kind === 'skipped' || !liveAtAnswer) return;
      const stillOpen = result.kind === 'posted' ? result.stillOpen : getSheet()?.draftId === sent;
      if (stillOpen) latest.current.onResult(result);
    });
  }, [status]);
}
