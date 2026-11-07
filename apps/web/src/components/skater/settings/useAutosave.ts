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
  const saveRef = useRef(save);
  saveRef.current = save;

  const run = useCallback(() => {
    timer.current = null;
    const sending = latest.current;
    if (sending === saved.current) {
      setStatus('saved');
      return;
    }
    setStatus('saving');
    saveRef.current(sending).then(
      () => {
        saved.current = sending;
        if (latest.current === sending) setStatus('saved');
      },
      () => {
        if (latest.current === sending) setStatus('failed');
      },
    );
  }, []);

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
      if (latest.current !== saved.current) void saveRef.current(latest.current).catch(() => {});
    },
    [],
  );

  return { value, setValue, status, flush };
}
