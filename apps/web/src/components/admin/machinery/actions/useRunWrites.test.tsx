import { renderHook } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, test, vi } from 'vitest';

import { createToastManager } from '@/components/kit/toast';

import { LOAD_ID, ZONE } from '../corpus/runFixtures';
import { type RunServer, useRunWrites } from './useRunWrites';

const TARGET = { runId: LOAD_ID, title: 'load' };
const UNTIL = Date.UTC(2026, 9, 12, 18, 42);

function setup(fail?: unknown) {
  const manager = createToastManager();
  const added: { title?: unknown; description?: unknown; timeout?: unknown }[] = [];
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
    markRunFailed: answer({ actionId: 'act_mark' }),
    waitOnRun: answer({ actionId: 'act_wait', until: UNTIL }),
    requestRunStop: answer({ actionId: 'act_stop' }),
  } as unknown as RunServer & Record<keyof RunServer, ReturnType<typeof vi.fn>>;
  const announce = vi.fn(async () => {});
  const { result } = renderHook(() =>
    useRunWrites({ server, announce, manager, clockNow: () => 1234, timeZone: ZONE }),
  );
  return { writes: result.current, server, announce, added };
}

describe('the run writes', () => {
  test('Mark failed sends the trimmed reason and raises its receipt with Undo', async () => {
    const { writes, server, announce, added } = setup();
    expect(await writes.markFailed(TARGET, '  Laptop slept  ')).toBe(true);
    expect(server.markRunFailed).toHaveBeenCalledWith({ runId: LOAD_ID, reason: 'Laptop slept' });
    expect(announce).toHaveBeenCalledWith({
      title: 'Marked failed',
      description:
        "Nothing was scheduled. If the loader's own close comes, it's kept beside the mark.",
      subject: 'load',
      target: { targetType: 'importRun', targetId: LOAD_ID },
      actionId: 'act_mark',
      undoNeedsReason: false,
    });
    expect(added).toHaveLength(0);
  });

  test('Wait sends the press instant and says until when', async () => {
    const { writes, server, announce } = setup();
    expect(await writes.wait(TARGET)).toBe(true);
    expect(server.waitOnRun).toHaveBeenCalledWith({ runId: LOAD_ID, now: 1234 });
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Waiting 30 minutes',
        description: 'The stalled alarm is held until 14:42',
        actionId: 'act_wait',
      }),
    );
  });

  test('Stop (behind its switch) asks and raises its receipt', async () => {
    const { writes, server, announce } = setup();
    expect(await writes.stop(TARGET)).toBe(true);
    expect(server.requestRunStop).toHaveBeenCalledWith({ runId: LOAD_ID });
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Asked to stop', actionId: 'act_stop' }),
    );
  });

  test("a refusal is one toast in the server's words, naming the run; nothing announced", async () => {
    const { writes, announce, added } = setup(new ConvexError('That run has already finished.'));
    expect(await writes.markFailed(TARGET, 'why')).toBe(false);
    expect(await writes.wait(TARGET)).toBe(false);
    expect(await writes.stop(TARGET)).toBe(false);
    expect(announce).not.toHaveBeenCalled();
    expect(added.map((a) => [a.title, a.description, a.timeout])).toEqual([
      ['Not marked failed · load', 'That run has already finished.', 0],
      ['Not waited on · load', 'That run has already finished.', 0],
      ['Not asked to stop · load', 'That run has already finished.', 0],
    ]);
  });

  test('a failed send is a toast too', async () => {
    const { writes, added } = setup(new Error('offline'));
    expect(await writes.wait(TARGET)).toBe(false);
    expect(added[0]?.description).toMatch(/check your connection/);
  });

  test('a receipt that fails to show never throws out of the write', async () => {
    const { writes, announce } = setup();
    announce.mockRejectedValueOnce(new Error('gone'));
    await expect(writes.markFailed(TARGET, 'x')).resolves.toBe(true);
  });
});
