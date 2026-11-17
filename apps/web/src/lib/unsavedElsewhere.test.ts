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

  it('goes on after the wait when the tab that held work closed mid-ask', async () => {
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
    for (const m of seen) {
      expect(Object.keys(m as object).sort()).toEqual(['ask', 'type']);
    }
    stop();
  });
});
