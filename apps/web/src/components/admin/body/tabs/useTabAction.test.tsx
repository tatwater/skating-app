import { renderHook } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tabs' write runner: a refusal in the server's words, a receipt once the write lands — and a
 * receipt that couldn't be shown never turns a landed write into a failure or a hung dialog.
 */

const mocks = vi.hoisted(() => ({ announce: vi.fn(async (_r: unknown) => {}) }));
vi.mock('../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { useTabAction } from './useTabAction';

const RECEIPT = { title: 'Saved', target: { targetType: 'waterbody' as const, targetId: 'wb1' } };

beforeEach(() => {
  mocks.announce.mockReset();
  mocks.announce.mockImplementation(async () => {});
  toasts.length = 0;
});

describe('useTabAction', () => {
  it('announces a landed write, and says a refusal in the server’s words', async () => {
    const { result } = renderHook(() => useTabAction());
    await expect(result.current.act(async () => {}, RECEIPT)).resolves.toBe(true);
    expect(mocks.announce).toHaveBeenCalledWith(RECEIPT);
    await expect(
      result.current.actInDialog(async () => {
        throw new ConvexError('This request has been decided');
      }, RECEIPT),
    ).resolves.toBe('This request has been decided');
    expect(mocks.announce).toHaveBeenCalledTimes(1);
  });

  it('keeps a landed write landed when its receipt can’t be shown', async () => {
    mocks.announce.mockImplementation(async () => {
      throw new Error('the toast queue is gone');
    });
    const { result } = renderHook(() => useTabAction());
    await expect(result.current.actInDialog(async () => {}, RECEIPT)).resolves.toBeNull();
    await expect(result.current.act(async () => {}, RECEIPT)).resolves.toBe(true);
    expect(toasts).toEqual([]);
  });
});
