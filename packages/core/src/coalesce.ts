/**
 * One run at a time, without dropping the requests that arrive during one.
 *
 * The obvious guard — `if (running) return` — is right about the first half and wrong about the
 * second. It stops two drains from racing, but it also throws away every request that lands while one
 * is in progress, and a queue drain **takes its snapshot up front**: an item written a millisecond
 * after that snapshot is invisible to the run already going. So the caller is told "a flush is
 * happening" when in fact the thing they just asked for is in none of them, and it waits for an
 * unrelated trigger — a reconnect, a foreground — to get sent.
 *
 * That's fine for a heartbeat and wrong for a button. Someone tapping "Retry" or "Sync now" is making
 * a claim about state that did not exist when the current run began.
 *
 * So a request that arrives mid-run schedules **one** follow-up run, and every such request resolves
 * against it: five taps during a drain produce one extra drain, not five, and all five awaits finish
 * only once that drain is done. What you asked for has actually happened by the time your await
 * returns — which is what lets a caller show "Sending…" and mean it.
 */
export function createCoalescedRunner(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let followUp: Promise<void> | null = null;

  function start(): Promise<void> {
    const started = run().finally(() => {
      // Guarded identity check: only the run that set this clears it.
      if (inFlight === started) inFlight = null;
    });
    inFlight = started;
    return started;
  }

  return function trigger(): Promise<void> {
    if (!inFlight) return start();
    // A failed run must not swallow the follow-up: the request that queued it is still unserved, and
    // the next run is its own attempt. The follow-up's *own* failure does propagate to its callers.
    followUp ??= inFlight
      .catch(() => {})
      .then(() => {
        followUp = null;
        return trigger();
      });
    return followUp;
  };
}
