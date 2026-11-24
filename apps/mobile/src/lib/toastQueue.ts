/**
 * The phone's toast, as state (D268: every server refusal is a toast, never inline). One toast at a
 * time, the rest waiting in order; the same words twice in a row are shown once (a double tap that
 * is refused twice is one thing to say). `src/components/Toast.tsx` draws it and runs the timer.
 */

export interface Toast {
  id: number;
  message: string;
}

export interface ToastQueue {
  current: Toast | null;
  waiting: readonly Toast[];
}

export const EMPTY_TOASTS: ToastQueue = { current: null, waiting: [] };

/** How long a toast stays up, unless it is tapped away. Long enough to read two lines. */
export const TOAST_MS = 5000;

/** How many toasts may wait: a burst of failures doesn't need a minute of toasts behind it. */
export const TOAST_WAITING_MAX = 3;

export function pushToast(queue: ToastQueue, toast: Toast): ToastQueue {
  const last = queue.waiting[queue.waiting.length - 1] ?? queue.current;
  if (last?.message === toast.message) return queue;
  if (queue.current === null) return { current: toast, waiting: [] };
  if (queue.waiting.length >= TOAST_WAITING_MAX) return queue;
  return { current: queue.current, waiting: [...queue.waiting, toast] };
}

/** The toast `id` is done (its time ran out, or it was tapped): the next one shows. */
export function dismissToast(queue: ToastQueue, id: number): ToastQueue {
  if (queue.current?.id !== id) return queue;
  const [next = null, ...rest] = queue.waiting;
  return { current: next, waiting: rest };
}
