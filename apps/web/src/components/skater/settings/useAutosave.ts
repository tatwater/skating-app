import { useCallback, useEffect, useRef, useState } from 'react';

import type { InputStatus } from '../../kit/input';

/** How long typing has to pause before a field saves itself. */
export const AUTOSAVE_DELAY_MS = 700;

/**
 * A text setting that saves itself (the kit input's autosave meta): `typing` while the person is
 * mid-word, `saving` once they pause, then `saved` — or `not saved`, keeping what they typed, so
 * the next keystroke tries again. A field never has a Save button to forget.
 *
 * The value is the person's from the first keystroke: a server echo arriving mid-edit never
 * overwrites it. A save that lands after a newer keystroke doesn't mark the field saved.
 */
export function useAutosave(
  initial: string,
  save: (value: string) => Promise<unknown>,
  delayMs: number = AUTOSAVE_DELAY_MS,
): { value: string; setValue: (next: string) => void; status: InputStatus; flush: () => void } {
  const [value, setLocal] = useState(initial);
  const [status, setStatus] = useState<InputStatus>('saved');
  const latest = useRef(initial);
  const saved = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Saves sent and not yet answered. */
  const inFlight = useRef(0);
  const saveRef = useRef(save);
  saveRef.current = save;

  /**
   * Is there nothing to send? Only when the value is the saved one *and* no older save is still
   * out: typed back to the saved text while a save of the longer one is in flight, skipping would
   * let that save land afterward and leave the server holding words the person took back.
   */
  const settled = useCallback(() => latest.current === saved.current && inFlight.current === 0, []);

  const run = useCallback(() => {
    timer.current = null;
    const sending = latest.current;
    if (settled()) {
      setStatus('saved');
      return;
    }
    setStatus('saving');
    inFlight.current += 1;
    saveRef.current(sending).then(
      () => {
        inFlight.current -= 1;
        saved.current = sending;
        if (latest.current === sending) setStatus('saved');
      },
      () => {
        inFlight.current -= 1;
        if (latest.current === sending) setStatus('failed');
      },
    );
  }, [settled]);

  const setValue = useCallback(
    (next: string) => {
      latest.current = next;
      setLocal(next);
      setStatus('typing');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(run, delayMs);
    },
    [run, delayMs],
  );

  /** Save now (a blur): what's typed shouldn't wait out the pause if the person has moved on. */
  const flush = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    run();
  }, [run]);

  // Leaving the page mid-pause still saves what was typed.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      if (!settled()) void saveRef.current(latest.current).catch(() => {});
    },
    [settled],
  );

  return { value, setValue, status, flush };
}
