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
import { useSaidMutation } from './saidMutation';

beforeEach(() => {
  mocks.refuse = null;
  mocks.toasts.length = 0;
});

/** A Legacy page's write, refused: said once, in a toast in the server's words. */
async function refused(mode: 'always' | 'inPlace', leave: boolean) {
  const { result, unmount } = renderHook(() => useSaidMutation(api.waterBodies.restore, mode));
  const sent = result.current({ waterBodyId: 'k1' as never });
  if (leave) unmount();
  await act(async () => {
    mocks.refuse?.();
    await sent.catch(() => {});
  });
}

describe('the Legacy pages’ net', () => {
  it('a page that says nothing of its own: the net says the refusal, and the page still sees it', async () => {
    await refused('always', false);
    expect(mocks.toasts).toEqual([
      expect.objectContaining({ title: 'Not saved', description: 'Not allowed' }),
    ]);
  });

  it('a page that says it in place: the net is quiet while the page is there', async () => {
    await refused('inPlace', false);
    expect(mocks.toasts).toEqual([]);
  });

  it('a page that says it in place, gone before the answer: the net says it, once', async () => {
    await refused('inPlace', true);
    expect(mocks.toasts).toHaveLength(1);
  });
});
