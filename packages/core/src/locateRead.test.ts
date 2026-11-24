import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocateRead, LOCATE_GIVE_UP_MS, type LocateReadState } from './locateRead';

/** A read the test answers by hand, one per `start`. */
function reads() {
  const out: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = [];
  const read = vi.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        out.push({ resolve, reject });
      }),
  );
  return { read, out };
}

function setup(giveUpMs?: number, dropAtGiveUp?: boolean) {
  const { read, out } = reads();
  const states: LocateReadState[] = [];
  const onFix = vi.fn();
  const locate = createLocateRead({
    read,
    onState: (s) => states.push(s),
    onFix,
    ...(giveUpMs !== undefined ? { giveUpMs } : {}),
    ...(dropAtGiveUp !== undefined ? { dropAtGiveUp } : {}),
  });
  return { locate, read, out, states, onFix };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 24, 15));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLocateRead', () => {
  it('takes a fix, and is idle again', async () => {
    const { locate, read, out, states, onFix } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    expect(states).toEqual(['locating']);
    out[0]?.resolve('here');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).toHaveBeenCalledWith('here');
    expect(states).toEqual(['locating', 'idle']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says a failed read', async () => {
    const { locate, out, states, onFix } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    out[0]?.reject(new Error('denied'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['locating', 'failed']);
    expect(onFix).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says a read that throws before it starts', async () => {
    const states: LocateReadState[] = [];
    const locate = createLocateRead({
      read: () => {
        throw new Error('unavailable');
      },
      onState: (s) => states.push(s),
      onFix: vi.fn(),
    });
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['locating', 'failed']);
  });

  it('stops looking busy at the give-up, and still takes a slowly answered fix', async () => {
    // A permission prompt answered after the give-up: the button came back, and the fix still counts
    // because nothing superseded it.
    const { locate, out, states, onFix } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS - 1);
    expect(states).toEqual(['locating']);
    await vi.advanceTimersByTimeAsync(1);
    expect(states).toEqual(['locating', 'idle']);
    out[0]?.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).toHaveBeenCalledWith('late');
    expect(states).toEqual(['locating', 'idle']);
  });

  it('with `dropAtGiveUp`, takes nothing after the give-up, fix or failure', async () => {
    const { locate, out, states, onFix } = setup(undefined, true);
    locate.start();
    await vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS);
    expect(states).toEqual(['locating', 'idle']);
    out[0]?.resolve('somewhere else, hours later');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).not.toHaveBeenCalled();
    locate.start();
    await vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS);
    out[1]?.reject(new Error('denied'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['locating', 'idle', 'locating', 'idle']);
    // A read answered inside the give-up still counts.
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    out[2]?.resolve('here');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).toHaveBeenCalledExactlyOnceWith('here');
  });

  it('says a slow failure after the give-up', async () => {
    const { locate, out, states } = setup(1_000);
    locate.start();
    await vi.advanceTimersByTimeAsync(1_000);
    out[0]?.reject(new Error('denied'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['locating', 'idle', 'failed']);
  });

  it('drops a fix the skater superseded (typed, picked, saved, skipped), even after the give-up', async () => {
    const { locate, out, states, onFix } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    locate.supersede();
    expect(states).toEqual(['locating', 'idle']);
    expect(vi.getTimerCount()).toBe(0);
    out[0]?.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).not.toHaveBeenCalled();

    locate.start();
    await vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS);
    locate.supersede();
    out[1]?.resolve('later');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).not.toHaveBeenCalled();
  });

  it('drops a superseded failure, and leaves a failure already said alone', async () => {
    const { locate, out, states } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    locate.supersede();
    out[0]?.reject(new Error('denied'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['locating', 'idle']);

    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    out[1]?.reject(new Error('denied'));
    await vi.advanceTimersByTimeAsync(0);
    locate.supersede();
    expect(states).toEqual(['locating', 'idle', 'locating', 'failed']);
  });

  it('takes only the newest of two reads, and the older one’s give-up changes nothing', async () => {
    const { locate, out, states, onFix } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS - 10);
    locate.start();
    await vi.advanceTimersByTimeAsync(10);
    // The first read's give-up would have fired here: it was cleared with the second press.
    expect(states).toEqual(['locating']);
    out[0]?.resolve('old');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).not.toHaveBeenCalled();
    out[1]?.resolve('new');
    await vi.advanceTimersByTimeAsync(0);
    expect(onFix).toHaveBeenCalledExactlyOnceWith('new');
  });

  it('says and takes nothing once disposed, and starts nothing', async () => {
    const { locate, read, out, states, onFix } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    locate.dispose();
    out[0]?.resolve('gone');
    await vi.advanceTimersByTimeAsync(LOCATE_GIVE_UP_MS);
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    expect(onFix).not.toHaveBeenCalled();
    expect(states).toEqual(['locating']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failure after dispose says nothing', async () => {
    const { locate, out, states } = setup();
    locate.start();
    await vi.advanceTimersByTimeAsync(0);
    locate.dispose();
    out[0]?.reject(new Error('denied'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['locating']);
  });
});
