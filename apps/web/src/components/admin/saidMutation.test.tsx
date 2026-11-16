import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refuse: null as null | (() => void),
  toasts: [] as { title: string; description?: string }[],
}));
vi.mock('convex/react', async () => {
  const { ConvexError } = await import('convex/values');
  return {
    useMutation: () => () =>
      new Promise((_, reject) => {
        mocks.refuse = () => reject(new ConvexError('Not allowed'));
      }),
  };
});
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => mocks.toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { drawn } from './place';
import { useSaidMutation } from './saidMutation';

beforeEach(() => {
  mocks.refuse = null;
  mocks.toasts.length = 0;
});

/** A Legacy page's write, refused; its place drawn or not when the answer comes. */
async function refused(place: { drawn: boolean } | null) {
  const where = place === null ? null : { here: () => place.drawn };
  const { result } = renderHook(() => useSaidMutation(api.waterBodies.restore, where));
  const sent = result.current({ waterBodyId: 'k1' as never });
  return async (drawnAtAnswer: boolean) => {
    if (place !== null) place.drawn = drawnAtAnswer;
    await act(async () => {
      mocks.refuse?.();
      await sent.catch(() => {});
    });
  };
}

describe('the Legacy pages’ net', () => {
  it('a page that says nothing of its own: the net says the refusal, and the page still sees it', async () => {
    await (await refused(null))(true);
    expect(mocks.toasts).toEqual([
      expect.objectContaining({ title: 'Not saved', description: 'Not allowed' }),
    ]);
  });

  it('a page that says it in place: the net is quiet while that place is drawn', async () => {
    await (await refused({ drawn: true }))(true);
    expect(mocks.toasts).toEqual([]);
  });

  /**
   * The place asked when the answer comes, never when the write was sent: a component that stays
   * mounted but stops drawing its error slot (a permission flipping, a read failing, a pane hidden)
   * has no place — the net says it, once.
   */
  it('a place no longer drawn when the answer comes — mounted or not: the net says it, once', async () => {
    await (await refused({ drawn: true }))(false);
    expect(mocks.toasts).toHaveLength(1);
  });
});

describe('a drawn place', () => {
  it('is drawn only in the document and outside anything hidden or inert', () => {
    const outer = document.body.appendChild(document.createElement('div'));
    const el = outer.appendChild(document.createElement('p'));
    expect(drawn(el)).toBe(true);
    outer.hidden = true;
    expect(drawn(el)).toBe(false);
    outer.hidden = false;
    outer.className = 'hidden';
    expect(drawn(el)).toBe(false);
    outer.className = '';
    outer.setAttribute('inert', '');
    expect(drawn(el)).toBe(false);
    outer.remove();
    expect(drawn(el)).toBe(false);
    expect(drawn(null)).toBe(false);
  });
});
