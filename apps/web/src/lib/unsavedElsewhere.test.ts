/**
 * The cross-tab ask behind every Sign out: does any other tab of this browser hold report work not
 * yet sent? Driven through the channel seam with a fake hub and fake timers — deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabsHub as hub } from '@/test/tabsHub';
import {
  answerUnsavedAsks,
  askOtherTabs,
  setUnsavedChannelForTests,
  UNSAVED_ASK_MS,
} from './unsavedElsewhere';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setUnsavedChannelForTests(undefined);
  vi.useRealTimers();
});

describe('askOtherTabs', () => {
  it('hears another tab that holds work, at once', async () => {
    const h = hub();
    setUnsavedChannelForTests(h.make);
    const stop = answerUnsavedAsks(() => true, 'tab-b');
    const answer = askOtherTabs('tab-a');
    await vi.advanceTimersByTimeAsync(0);
    await expect(answer).resolves.toBe('held');
    stop();
  });

  it('answers none after the bounded wait when no tab holds anything', async () => {
    const h = hub();
    setUnsavedChannelForTests(h.make);
    const stop = answerUnsavedAsks(() => false, 'tab-b');
    let settled: string | null = null;
    void askOtherTabs('tab-a').then((a) => {
      settled = a;
    });
    await vi.advanceTimersByTimeAsync(UNSAVED_ASK_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('none');
    stop();
    // Nothing left open behind the ask.
    expect(h.open.size).toBe(0);
  });

  it('never hears its own tab', async () => {
    const h = hub();
    setUnsavedChannelForTests(h.make);
    const stop = answerUnsavedAsks(() => true, 'tab-a');
    const answer = askOtherTabs('tab-a');
    await vi.advanceTimersByTimeAsync(UNSAVED_ASK_MS);
    await expect(answer).resolves.toBe('none');
    stop();
  });

  it('goes on after the wait when the tab that held work closed before it could answer', async () => {
    const h = hub();
    setUnsavedChannelForTests(h.make);
    const stop = answerUnsavedAsks(() => true, 'tab-b');
    stop(); // closed before it could answer
    const answer = askOtherTabs('tab-a');
    await vi.advanceTimersByTimeAsync(UNSAVED_ASK_MS);
    await expect(answer).resolves.toBe('none');
  });

  it('says unknown — never none — when the browser can’t ask its tabs', async () => {
    setUnsavedChannelForTests(() => null);
    await expect(askOtherTabs('tab-a')).resolves.toBe('unknown');
    // And a tab there answers nothing, without throwing.
    expect(() => answerUnsavedAsks(() => true, 'tab-b')()).not.toThrow();
  });

  it('carries no content: the ask and the answer are ids and a word', async () => {
    const h = hub();
    setUnsavedChannelForTests(h.make);
    const seen: unknown[] = [];
    const spy = h.make();
    spy.listen((m) => seen.push(m));
    const stop = answerUnsavedAsks(() => true, 'tab-b');
    const answer = askOtherTabs('tab-a');
    await vi.advanceTimersByTimeAsync(0);
    await answer;
    // The ask and its answer, both heard.
    expect(seen).toHaveLength(2);
    for (const m of seen) {
      expect(Object.keys(m as object).sort()).toEqual(['ask', 'type']);
    }
    stop();
  });

  it('hears only an ask, and only the answer to its own ask', async () => {
    const h = hub();
    setUnsavedChannelForTests(h.make);
    const holds = vi.fn(() => true);
    const stop = answerUnsavedAsks(holds, 'tab-b');
    const stranger = h.make();
    for (const junk of [
      null,
      'ask',
      7,
      { type: 'ask' },
      { type: 'nudge', ask: 'tab-c:1' },
      { type: 'held', ask: 'tab-c:1' },
    ]) {
      stranger.post(junk);
    }
    expect(holds).not.toHaveBeenCalled();
    stop();
    // Someone else's answer is not this ask's.
    let settled: string | null = null;
    void askOtherTabs('tab-a').then((a) => {
      settled = a;
    });
    stranger.post({ type: 'held', ask: 'tab-c:1' });
    await vi.advanceTimersByTimeAsync(UNSAVED_ASK_MS);
    expect(settled).toBe('none');
    stranger.close();
  });
});

describe('the browser’s channel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('carries the ask to another tab and its answer back', async () => {
    setUnsavedChannelForTests(undefined);
    const stop = answerUnsavedAsks(() => true, 'tab-b');
    await expect(askOtherTabs('tab-a')).resolves.toBe('held');
    stop();
  });

  it('answers none after the wait when no tab holds anything', async () => {
    setUnsavedChannelForTests(undefined);
    const stop = answerUnsavedAsks(() => false, 'tab-b');
    const answer = askOtherTabs('tab-a');
    await vi.advanceTimersByTimeAsync(UNSAVED_ASK_MS);
    await expect(answer).resolves.toBe('none');
    stop();
  });

  it.each([
    ['has none', undefined],
    [
      'refuses one',
      class {
        constructor() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        }
      },
    ],
  ])('says unknown when the browser %s, and a tab there answers nothing', async (_, stub) => {
    vi.stubGlobal('BroadcastChannel', stub);
    setUnsavedChannelForTests(undefined);
    await expect(askOtherTabs('tab-a')).resolves.toBe('unknown');
    expect(() => answerUnsavedAsks(() => true, 'tab-b')()).not.toThrow();
  });

  it('says unknown when the ask can’t go out', async () => {
    const closed = vi.fn();
    setUnsavedChannelForTests(() => ({
      post: () => {
        throw new DOMException('Channel is closed.', 'InvalidStateError');
      },
      listen: () => () => {},
      close: closed,
    }));
    await expect(askOtherTabs('tab-a')).resolves.toBe('unknown');
    expect(closed).toHaveBeenCalledOnce();
  });
});
