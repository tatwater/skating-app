import { act, renderHook } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  answer: null as null | ((err?: unknown) => void),
  toasts: [] as Record<string, unknown>[],
}));
vi.mock('convex/react', () => ({
  useMutation: () => () =>
    new Promise((resolve, reject) => {
      mocks.answer = (err) => (err === undefined ? resolve('ok') : reject(err));
    }),
}));
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: Record<string, unknown>) => mocks.toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { NOT_SAVED, Refused, said, sayRefusal, useRefusalClears, useSaidMutation } from './said';

beforeEach(() => {
  mocks.answer = null;
  mocks.toasts.length = 0;
});

const words = (why: string) => ({ title: 'Not saved · Mascoma Lake', description: why });

/** Every way a write can fail to land, and the words its toast says. */
const FAILURES = [
  ['refused', new ConvexError('Not allowed for this body'), 'Not allowed for this body'],
  [
    'refused, in a structured answer',
    new ConvexError({ message: 'Already hidden' }),
    'Already hidden',
  ],
  ['a server error', new ConvexError({ code: 'internal' }), 'That write was rejected.'],
  [
    'a failed send',
    new TypeError('Failed to fetch'),
    'Something went wrong — check your connection and try again.',
  ],
] as const;

describe('said — the one write helper', () => {
  it('a landed write: its value, and nothing said', async () => {
    await expect(said(async () => 7, words)).resolves.toEqual({ landed: true, value: 7 });
    expect(mocks.toasts).toEqual([]);
  });

  it.each(FAILURES)(
    '%s: one toast that stays, and the caller hears only that it did not land',
    async (_, err, why) => {
      const answer = await said(async () => {
        throw err;
      }, words);
      // No words reach the caller: nothing but `landed`.
      expect(answer).toEqual({ landed: false });
      expect(mocks.toasts).toEqual([
        { title: 'Not saved · Mascoma Lake', description: why, tone: 'bad', timeout: 0 },
      ]);
    },
  );

  it('a throw it is told to pass on (a list that moved, for its queue) goes back untouched, unsaid', async () => {
    const moved = new ConvexError({ code: 'list_changed', current: [] });
    await expect(
      said(
        async () => {
          throw moved;
        },
        words,
        { passOn: (e) => e === moved },
      ),
    ).rejects.toBe(moved);
    expect(mocks.toasts).toEqual([]);
  });

  it('a refusal toast never carries an Undo, and an empty why says only its title', () => {
    sayRefusal({ title: 'Not undone', description: '' });
    expect(mocks.toasts).toEqual([{ title: 'Not undone', tone: 'bad', timeout: 0 }]);
  });
});

describe('the Legacy pages’ net (`useSaidMutation`)', () => {
  it.each(FAILURES)(
    '%s: one toast in the server’s words, then a word-less Refused',
    async (_, err, why) => {
      const { result } = renderHook(() => useSaidMutation(api.waterBodies.restore));
      const sent = result.current({ waterBodyId: 'k1' as never });
      let caught: unknown;
      await act(async () => {
        mocks.answer?.(err);
        await sent.catch((e: unknown) => {
          caught = e;
        });
      });
      expect(caught).toBeInstanceOf(Refused);
      // Nothing of the server's to print: the error a page catches has no words.
      expect((caught as Error).message).toBe('');
      expect(mocks.toasts).toEqual([
        { title: NOT_SAVED, description: why, tone: 'bad', timeout: 0 },
      ]);
    },
  );

  it('a landed write answers its value, and says nothing', async () => {
    const { result } = renderHook(() => useSaidMutation(api.waterBodies.restore));
    const sent = result.current({ waterBodyId: 'k1' as never });
    await act(async () => mocks.answer?.());
    await expect(sent).resolves.toBe('ok');
    expect(mocks.toasts).toEqual([]);
  });
});

describe('a refusal lets a Legacy page’s last outcome go (`useRefusalClears`)', () => {
  it('clears while the page is mounted, and never after', () => {
    const clear = vi.fn();
    const { unmount } = renderHook(() => useRefusalClears(clear));
    sayRefusal({ title: 'Not saved', description: 'Not allowed' });
    expect(clear).toHaveBeenCalledTimes(1);
    unmount();
    sayRefusal({ title: 'Not saved', description: 'Not allowed' });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
