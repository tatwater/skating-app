import { renderHook } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tabs' write runner: a refusal in a toast naming the body (D268) wherever the console is, a
 * receipt once the write lands — and a receipt that couldn't be shown never turns a landed write
 * into a failure or a hung dialog.
 */

const mocks = vi.hoisted(() => ({ announce: vi.fn(async (_r: unknown) => {}) }));
vi.mock('../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { BodyBindingProvider } from '../frame/currentBody';
import { useTabAction } from './useTabAction';

const RECEIPT = { title: 'Saved', target: { targetType: 'waterbody' as const, targetId: 'wb1' } };

beforeEach(() => {
  mocks.announce.mockReset();
  mocks.announce.mockImplementation(async () => {});
  toasts.length = 0;
});

describe('useTabAction', () => {
  it('announces a landed write; a refusal is a toast, and the caller hears only false', async () => {
    const { result } = renderHook(() => useTabAction('wb1'));
    await expect(result.current.act(async () => {}, RECEIPT)).resolves.toBe(true);
    expect(mocks.announce).toHaveBeenCalledWith(expect.objectContaining(RECEIPT));
    await expect(
      result.current.act(async () => {
        throw new ConvexError('This request has been decided');
      }, RECEIPT),
    ).resolves.toBe(false);
    expect(toasts).toEqual([
      expect.objectContaining({ description: 'Saved: This request has been decided', tone: 'bad' }),
    ]);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['mounted', false],
    ['its console gone', true],
  ])('a refusal, %s: the same one toast naming the body', async (_, gone) => {
    const { result, unmount } = renderHook(() => useTabAction('wb1'), {
      wrapper: ({ children }) => (
        <BodyBindingProvider bodyId="wb1" name="Mascoma Lake">
          {children}
        </BodyBindingProvider>
      ),
    });
    const { act, attempt } = result.current;
    if (gone) unmount();
    await expect(
      act(async () => {
        throw new ConvexError('Water body not found');
      }, RECEIPT),
    ).resolves.toBe(false);
    await expect(
      attempt(
        async () => {
          throw new ConvexError('Water body not found');
        },
        RECEIPT,
        'The class',
      ),
    ).resolves.toEqual({ landed: false });
    expect(toasts).toEqual([
      {
        title: 'Not saved · Mascoma Lake',
        description: 'Saved: Water body not found',
        tone: 'bad',
        timeout: 0,
      },
      {
        title: 'Not saved · Mascoma Lake',
        description: 'The class: Water body not found',
        tone: 'bad',
        timeout: 0,
      },
    ]);
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it('builds a receipt from the write’s own answer, and words a refusal from “The change”', async () => {
    const { result } = renderHook(() => useTabAction('wb1'));
    const fromAnswer = (answer: { actionId: string }) => ({
      ...RECEIPT,
      actionId: answer.actionId,
    });
    await expect(result.current.act(async () => ({ actionId: 'ma1' }), fromAnswer)).resolves.toBe(
      true,
    );
    expect(mocks.announce).toHaveBeenCalledWith(
      expect.objectContaining({ ...RECEIPT, actionId: 'ma1' }),
    );
    await expect(
      result.current.act(async (): Promise<{ actionId: string }> => {
        throw new ConvexError('Water body not found');
      }, fromAnswer),
    ).resolves.toBe(false);
    expect(toasts).toEqual([
      expect.objectContaining({ description: 'The change: Water body not found' }),
    ]);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
  });

  it('keeps a landed write landed when its receipt can’t be shown', async () => {
    mocks.announce.mockImplementation(async () => {
      throw new Error('the toast queue is gone');
    });
    const { result } = renderHook(() => useTabAction('wb1'));
    await expect(result.current.attempt(async () => {}, RECEIPT, 'x')).resolves.toEqual({
      landed: true,
    });
    await expect(result.current.act(async () => {}, RECEIPT)).resolves.toBe(true);
    expect(toasts).toEqual([]);
  });
});
