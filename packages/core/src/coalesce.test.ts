import { describe, expect, it, vi } from 'vitest';
import { createCoalescedRunner } from './coalesce';

/** A promise you resolve by hand, so a "run" can be held open across assertions. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createCoalescedRunner', () => {
  it('runs immediately when nothing is in flight', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await createCoalescedRunner(run)();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never runs two at once — the part a plain boolean guard got right', async () => {
    const first = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const trigger = createCoalescedRunner(run);

    void trigger();
    void trigger();
    expect(run).toHaveBeenCalledTimes(1);

    first.resolve();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  // The defect this exists for: a drain snapshots its queue up front, so an item written during one
  // is in none of its batches. Dropping the request leaves that item unsent until an unrelated trigger.
  it('serves a request that arrives mid-run with a follow-up run', async () => {
    const first = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const trigger = createCoalescedRunner(run);

    void trigger();
    const during = trigger();
    first.resolve();
    await during;

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("resolves the mid-run caller only after ITS run finished — so 'Sending…' means it", async () => {
    const first = deferred();
    const second = deferred();
    const run = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(undefined);
    const trigger = createCoalescedRunner(run);

    void trigger();
    let settled = false;
    const during = trigger().then(() => {
      settled = true;
    });

    first.resolve();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false); // the follow-up is still going

    second.resolve();
    await during;
    expect(settled).toBe(true);
  });

  it('coalesces many mid-run requests into ONE follow-up, and they all wait on it', async () => {
    const first = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const trigger = createCoalescedRunner(run);

    void trigger();
    const waiting = [trigger(), trigger(), trigger()];
    first.resolve();
    await Promise.all(waiting);

    // Five taps during a drain are one extra drain, not five.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('still serves the follow-up when the run in progress fails', async () => {
    const first = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const trigger = createCoalescedRunner(run);

    void trigger().catch(() => {});
    const during = trigger();
    first.reject(new Error('network died mid-drain'));
    await during;

    // The failed run was somebody else's attempt; this request has still never been served.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('recovers to idle after a failure instead of wedging forever', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const trigger = createCoalescedRunner(run);

    await expect(trigger()).rejects.toThrow('boom');
    await trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('chains another follow-up for a request arriving during the follow-up', async () => {
    const first = deferred();
    const second = deferred();
    const run = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(undefined);
    const trigger = createCoalescedRunner(run);

    void trigger();
    void trigger();
    first.resolve();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    // Arrives while the follow-up is running: it, too, must not be dropped.
    const third = trigger();
    second.resolve();
    await third;
    expect(run).toHaveBeenCalledTimes(3);
  });
});
