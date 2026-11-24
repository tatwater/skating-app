import { describe, expect, it } from 'vitest';
import { dismissToast, EMPTY_TOASTS, pushToast, TOAST_WAITING_MAX } from './toastQueue';

const t = (id: number, message = `m${id}`) => ({ id, message });

describe('pushToast', () => {
  it('shows the first at once and queues the rest in order', () => {
    let q = pushToast(EMPTY_TOASTS, t(1));
    expect(q.current).toEqual(t(1));
    q = pushToast(q, t(2));
    q = pushToast(q, t(3));
    expect(q.current).toEqual(t(1));
    expect(q.waiting).toEqual([t(2), t(3)]);
  });

  it('says the same words once in a row', () => {
    const q = pushToast(EMPTY_TOASTS, t(1, 'same'));
    expect(pushToast(q, t(2, 'same'))).toBe(q);
    const q2 = pushToast(q, t(3, 'other'));
    expect(pushToast(q2, t(4, 'other'))).toBe(q2);
    expect(pushToast(q2, t(5, 'same')).waiting).toHaveLength(2);
  });

  it('caps the waiting line', () => {
    let q = pushToast(EMPTY_TOASTS, t(0));
    for (let i = 1; i <= TOAST_WAITING_MAX + 2; i++) q = pushToast(q, t(i));
    expect(q.waiting).toHaveLength(TOAST_WAITING_MAX);
  });
});

describe('dismissToast', () => {
  it('moves to the next, and ignores a stale id', () => {
    let q = pushToast(pushToast(EMPTY_TOASTS, t(1)), t(2));
    expect(dismissToast(q, 2)).toBe(q);
    q = dismissToast(q, 1);
    expect(q).toEqual({ current: t(2), waiting: [] });
    q = dismissToast(q, 2);
    expect(q).toEqual(EMPTY_TOASTS);
    expect(dismissToast(q, 2)).toBe(q);
  });
});
