import { renderHook } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, test, vi } from 'vitest';

import { createToastManager } from '@/components/kit/toast';

import { type ImageryServer, useImageryWrites } from './useImageryWrites';

const SEASON = 'winter-2026-27';
const TARGET = { targetType: 'imagerySeason', targetId: SEASON };

function setup(fail?: unknown, requeued = 3) {
  const manager = createToastManager();
  const added: { title?: unknown; description?: unknown; tone?: unknown }[] = [];
  const add = manager.add.bind(manager);
  manager.add = ((options: (typeof added)[number]) => {
    added.push(options);
    return add(options as never);
  }) as typeof manager.add;
  const answer = <T,>(value: T) =>
    vi.fn(async () => {
      if (fail !== undefined) throw fail;
      return value;
    });
  const server = {
    startImagery: answer({ actionId: 'act_start' }),
    pauseImagery: answer({ actionId: 'act_pause' }),
    pollNow: answer({ actionId: 'act_poll' }),
    retryFailed: answer({ actionId: 'act_retry', requeued }),
    tryAgainNow: answer({ actionId: 'act_again' }),
  } as unknown as ImageryServer & Record<keyof ImageryServer, ReturnType<typeof vi.fn>>;
  const announce = vi.fn(async (_receipt: unknown) => {});
  const { result } = renderHook(() => useImageryWrites({ server, announce, manager }));
  return { writes: result.current, server, announce, added };
}

describe('the imagery writes', () => {
  test('Start sends the season and raises its receipt with Undo', async () => {
    const { writes, server, announce, added } = setup();
    expect(await writes.start(SEASON)).toBe(true);
    expect(server.startImagery).toHaveBeenCalledWith({ season: SEASON });
    expect(announce).toHaveBeenCalledWith({
      title: 'Imagery started',
      description: 'The catalogs are checked right away, then every 6 hours.',
      target: TARGET,
      actionId: 'act_start',
      undoNeedsReason: false,
    });
    expect(added).toHaveLength(0);
  });

  test('Resume is the same write, worded as a resume', async () => {
    const { writes, server, announce } = setup();
    expect(await writes.start(SEASON, true)).toBe(true);
    expect(server.startImagery).toHaveBeenCalledWith({ season: SEASON });
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ title: 'Imagery resumed' }));
  });

  test('Pause raises its receipt with Undo (the server’s inverse resumes it)', async () => {
    const { writes, server, announce } = setup();
    expect(await writes.pause(SEASON)).toBe(true);
    expect(server.pauseImagery).toHaveBeenCalledWith({ season: SEASON });
    const receipt = announce.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(receipt).toMatchObject({ title: 'Imagery paused', actionId: 'act_pause' });
    expect(receipt).not.toHaveProperty('undoable');
  });

  test('the three triggers raise receipts with no Undo', async () => {
    const { writes, server, announce } = setup(undefined, 1);
    expect(await writes.pollNow(SEASON)).toBe(true);
    expect(await writes.retryFailed(SEASON)).toBe(true);
    expect(await writes.tryAgainNow(SEASON)).toBe(true);
    expect(server.pollNow).toHaveBeenCalledWith({});
    expect(server.retryFailed).toHaveBeenCalledWith({});
    expect(server.tryAgainNow).toHaveBeenCalledWith({});
    const receipts = announce.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);
    expect(receipts.map((r) => r.title)).toEqual([
      'Checking the catalogs now',
      '1 failed cut is back in line',
      'Trying again now',
    ]);
    for (const r of receipts) expect(r.undoable).toBe(false);
  });

  test('Retry failed says how many went back', async () => {
    const { writes, announce } = setup(undefined, 4);
    await writes.retryFailed(SEASON);
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ title: '4 failed cuts are back in line' }),
    );
  });

  test.each([
    ['start', 'Imagery not started'],
    ['pause', 'Imagery not paused'],
    ['pollNow', 'Catalogs not checked'],
    ['retryFailed', 'Failed cuts not retried'],
    ['tryAgainNow', 'Not tried again'],
  ] as const)(
    'a refused %s is one toast in the server’s words, and no receipt',
    async (w, title) => {
      const { writes, announce, added } = setup(new ConvexError('Imagery isn’t running.'));
      expect(await writes[w](SEASON)).toBe(false);
      expect(announce).not.toHaveBeenCalled();
      expect(added).toEqual([
        expect.objectContaining({ title, description: 'Imagery isn’t running.', type: 'bad' }),
      ]);
    },
  );

  test('a refused resume says it wasn’t resumed', async () => {
    const { writes, added } = setup(new ConvexError('The watch has ended.'));
    expect(await writes.start(SEASON, true)).toBe(false);
    expect(added[0]).toMatchObject({ title: 'Imagery not resumed' });
  });
});
