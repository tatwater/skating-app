import { TERMS_OPEN_RETRY_GAP_MS } from '@skating/core';
import { ConvexError } from 'convex/values';
import { describe, expect, it, vi } from 'vitest';
import {
  createTermsReading,
  endMarkerOnScreen,
  readingProgress,
  type ScrollMetrics,
  type TermsReadingState,
} from './termsReading';

const at = (offsetY: number, viewportHeight = 600, contentHeight = 3000): ScrollMetrics => ({
  offsetY,
  viewportHeight,
  contentHeight,
});

/** A promise the test settles by hand. */
function deferred() {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A pinned clock (D243) the test moves by hand: the retries' spacing reads it. */
function clock() {
  let at = Date.UTC(2026, 10, 24, 15);
  return {
    now: () => at,
    pass: (ms: number) => {
      at += ms;
    },
  };
}

describe('readingProgress', () => {
  it('runs from 0 at the top to 1 at the bottom, clamped', () => {
    expect(readingProgress(at(0))).toBe(0);
    expect(readingProgress(at(1200))).toBe(0.5);
    expect(readingProgress(at(2400))).toBe(1);
    // Overscroll on either end.
    expect(readingProgress(at(-40))).toBe(0);
    expect(readingProgress(at(2600))).toBe(1);
  });

  it('is full when everything fits, and empty before anything is laid out', () => {
    expect(readingProgress(at(0, 800, 500))).toBe(1);
    expect(readingProgress(at(0, 0, 0))).toBe(0);
  });
});

describe('endMarkerOnScreen', () => {
  it('counts the marker once its top is inside the window', () => {
    expect(endMarkerOnScreen(at(0), 2900)).toBe(false);
    expect(endMarkerOnScreen(at(2299), 2900)).toBe(false);
    expect(endMarkerOnScreen(at(2300), 2900)).toBe(true);
    expect(endMarkerOnScreen(at(2400), 2900)).toBe(true);
  });

  it('counts a marker that is on screen without a scroll', () => {
    expect(endMarkerOnScreen(at(0, 800, 500), 450)).toBe(true);
  });

  it('never counts before the marker or the window is measured', () => {
    expect(endMarkerOnScreen(at(2400), null)).toBe(false);
    expect(endMarkerOnScreen(at(0, 0, 0), 0)).toBe(false);
  });
});

describe('createTermsReading', () => {
  function setup() {
    const open = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
    const reach = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
    const onRefusal = vi.fn();
    const onUnopened = vi.fn();
    const toTop = vi.fn();
    const time = clock();
    const states: TermsReadingState[] = [];
    const reading = createTermsReading({
      open: () => open(),
      reach: () => reach(),
      onRefusal,
      onUnopened,
      onChange: (s) => states.push(s),
      toTop,
      now: time.now,
    });
    return { reading, open, reach, onRefusal, onUnopened, toTop, states, time };
  }

  it('opens, fills the hairline, and records the end once', async () => {
    const { reading, open, reach, states } = setup();
    reading.start();
    // A second start (a remount's effect) opens nothing more.
    reading.start();
    expect(open).toHaveBeenCalledTimes(1);
    await flush();
    reading.observe(at(1200), 2900);
    expect(reading.state()).toEqual({ end: 'unseen', progress: 0.5 });
    reading.observe(at(2400), 2900);
    expect(reading.state().end).toBe('recording');
    reading.observe(at(2400), 2900);
    await flush();
    expect(reading.state()).toEqual({ end: 'recorded', progress: 1 });
    // The opening is reused, never repeated, and the end is stamped once.
    expect(open).toHaveBeenCalledTimes(1);
    expect(reach).toHaveBeenCalledTimes(1);
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.end).toBe('recorded');
  });

  it('never counts an end reached while the opening is out: it must leave and come back after', async () => {
    const opened = deferred();
    const reach = vi.fn(() => Promise.resolve(null));
    const reading = createTermsReading({
      open: () => opened.promise,
      reach,
      onRefusal: vi.fn(),
      onChange: () => {},
    });
    reading.start();
    reading.observe(at(2400), 2900);
    // Left and reached again while the opening is still out: neither counts.
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    expect(reading.state().end).toBe('unseen');
    opened.resolve();
    await flush();
    // Answered, but this arrival began before it: no stamp in the same breath as the opening.
    expect(reach).not.toHaveBeenCalled();
    reading.observe(at(2410), 2900);
    await flush();
    expect(reach).not.toHaveBeenCalled();
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledTimes(1);
    expect(reading.state().end).toBe('recorded');
  });

  it('a failed stamp is toasted, and tried again only when the end comes back on screen', async () => {
    const { reading, reach, onRefusal } = setup();
    reach.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    expect(reading.state().end).toBe('failed');
    expect(onRefusal).toHaveBeenCalledTimes(1);
    // Still on screen: no retry per scroll event.
    reading.observe(at(2410), 2900);
    await flush();
    expect(reach).toHaveBeenCalledTimes(1);
    // Off screen, then back.
    reading.observe(at(100), 2900);
    expect(reading.state().end).toBe('unseen');
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledTimes(2);
    expect(reading.state().end).toBe('recorded');
  });

  it('a failed opening is toasted once; its end, still unopened, says why and starts again from the top', async () => {
    const { reading, open, reach, onRefusal, onUnopened, toTop } = setup();
    open.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    reading.start();
    await flush();
    expect(onRefusal).toHaveBeenCalledTimes(1);
    reading.observe(at(2400), 2900);
    await flush();
    // No reading on the server: said (`terms_not_opened`'s words), opened anew, from the top, and
    // nothing stamped in the same breath.
    expect(onUnopened).toHaveBeenCalledOnce();
    expect(toTop).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    expect(reach).not.toHaveBeenCalled();
    expect(reading.state()).toEqual({ end: 'unseen', progress: 0 });
    // The end counts only when reached again: not on a stale report from before the scroll.
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).not.toHaveBeenCalled();
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledTimes(1);
    expect(reading.state().end).toBe('recorded');
    expect(onRefusal).toHaveBeenCalledTimes(1);
  });

  it('an opening that fails with the end on screen is said; the end, back again, says why and restarts', async () => {
    const opened = deferred();
    const open = vi.fn().mockReturnValueOnce(opened.promise).mockResolvedValue(null);
    const reach = vi.fn(() => Promise.resolve(null));
    const toTop = vi.fn();
    const onRefusal = vi.fn();
    const onUnopened = vi.fn();
    const reading = createTermsReading({
      open,
      reach,
      onRefusal,
      onUnopened,
      onChange: () => {},
      toTop,
    });
    reading.start();
    reading.observe(at(2400), 2900);
    // The end never waits on an opening still out.
    expect(reading.state().end).toBe('unseen');
    opened.reject(new Error('offline'));
    await flush();
    // The screen's first opening says its own failure; the end, reached before it answered, waits.
    expect(onRefusal).toHaveBeenCalledOnce();
    expect(onUnopened).not.toHaveBeenCalled();
    reading.observe(at(2410), 2900);
    expect(open).toHaveBeenCalledOnce();
    // Left and reached again, still unopened: why, and from the top.
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(onUnopened).toHaveBeenCalledOnce();
    expect(onRefusal).toHaveBeenCalledOnce();
    expect(toTop).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    expect(reach).not.toHaveBeenCalled();
    expect(reading.state().end).toBe('unseen');
  });

  it('rearm stamps again at once if the end is still on screen, on the opening it has', async () => {
    const { reading, open, reach } = setup();
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    expect(reading.state().end).toBe('recorded');
    reading.rearm();
    expect(reading.state().end).toBe('recording');
    await flush();
    // Never a new opening stamped in the same breath as its end: the opening is the reading's.
    expect(open).toHaveBeenCalledOnce();
    expect(reach).toHaveBeenCalledTimes(2);
    expect(reading.state().end).toBe('recorded');
  });

  it('rearm on a reading the server lost: terms_not_opened, said, and read again from the top', async () => {
    const { reading, open, reach, onRefusal, toTop } = setup();
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    reach.mockImplementationOnce(() =>
      Promise.reject(new ConvexError({ code: 'terms_not_opened', message: 'Not opened.' })),
    );
    reading.rearm();
    await flush();
    expect(onRefusal).toHaveBeenCalledOnce();
    expect(toTop).toHaveBeenCalledOnce();
    // The second opening is the new reading's, and its end waits for the marker to come back.
    expect(open).toHaveBeenCalledTimes(2);
    expect(reach).toHaveBeenCalledTimes(2);
    expect(reading.state().end).toBe('unseen');
  });

  it('rearm away from the end waits for the scroll', async () => {
    const { reading, reach } = setup();
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    reading.observe(at(0), 2900);
    reading.rearm();
    await flush();
    expect(reading.state().end).toBe('unseen');
    expect(reach).toHaveBeenCalledTimes(1);
  });

  it('restart empties the reader and opens again; a stale answer changes nothing', async () => {
    const reached = deferred();
    const open = vi.fn(() => Promise.resolve(null));
    const reading = createTermsReading({
      open,
      reach: () => reached.promise,
      onRefusal: vi.fn(),
      onChange: () => {},
    });
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    reading.restart();
    expect(reading.state()).toEqual({ end: 'unseen', progress: 0 });
    expect(open).toHaveBeenCalledTimes(2);
    reached.resolve();
    await flush();
    expect(reading.state().end).toBe('unseen');
  });

  it('says nothing after dispose', async () => {
    const reached = deferred();
    const onChange = vi.fn();
    const onRefusal = vi.fn();
    const reading = createTermsReading({
      open: () => Promise.resolve(null),
      reach: () => reached.promise,
      onRefusal,
      onChange,
    });
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    // The stamp is out when the screen goes.
    await flush();
    const calls = onChange.mock.calls.length;
    reading.dispose();
    reached.reject(new Error('gone'));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(calls);
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it('says nothing about a failed opening after dispose', async () => {
    const onRefusal = vi.fn();
    const reading = createTermsReading({
      open: () => Promise.reject(new Error('gone')),
      reach: () => Promise.resolve(null),
      onRefusal,
      onChange: () => {},
    });
    reading.start();
    reading.dispose();
    await flush();
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it('rearm before any scroll only resets', () => {
    const { reading, reach } = setup();
    reading.rearm();
    expect(reading.state().end).toBe('unseen');
    expect(reach).not.toHaveBeenCalled();
  });

  it('an opening that answers after a newer reading began stamps nothing', async () => {
    const first = deferred();
    const open = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(null);
    const reach = vi.fn(() => Promise.resolve(null));
    const reading = createTermsReading({ open, reach, onRefusal: vi.fn(), onChange: () => {} });
    reading.start();
    reading.observe(at(2400), 2900);
    // Reached while the first opening is out; the reading starts again before it answers.
    reading.restart();
    first.resolve();
    await flush();
    expect(reach).not.toHaveBeenCalled();
    expect(reading.state().end).toBe('unseen');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('an opening that fails after a newer reading began neither restarts nor speaks', async () => {
    const first = deferred();
    const open = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(null);
    const onRefusal = vi.fn();
    const onUnopened = vi.fn();
    const toTop = vi.fn();
    const reading = createTermsReading({
      open,
      reach: () => Promise.resolve(null),
      onRefusal,
      onUnopened,
      onChange: () => {},
      toTop,
    });
    reading.start();
    reading.observe(at(2400), 2900);
    reading.restart();
    expect(toTop).toHaveBeenCalledOnce();
    first.reject(new Error('late'));
    await flush();
    // The newer reading's opening stands; the stale failure changed nothing.
    expect(toTop).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    expect(onRefusal).not.toHaveBeenCalled();
    expect(onUnopened).not.toHaveBeenCalled();
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reading.state().end).toBe('recorded');
  });

  it('a change after dispose is kept but not told', () => {
    const onChange = vi.fn();
    const reading = createTermsReading({
      open: () => Promise.resolve(null),
      reach: () => Promise.resolve(null),
      onRefusal: vi.fn(),
      onChange,
    });
    reading.dispose();
    reading.observe(at(1200), 2900);
    expect(reading.state().progress).toBe(0.5);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('an out-of-date build (client_outdated)', () => {
  const OUTDATED = new ConvexError({ code: 'client_outdated', message: 'Out of date.' });

  it('a refused opening is final: told once, and nothing opens or stamps again', async () => {
    const open = vi.fn(() => Promise.reject(OUTDATED));
    const reach = vi.fn(() => Promise.resolve(null));
    const onRefusal = vi.fn();
    const reading = createTermsReading({ open, reach, onRefusal, onChange: () => {} });
    reading.start();
    await flush();
    expect(reading.state().end).toBe('outdated');
    expect(onRefusal).toHaveBeenCalledOnce();
    // The end on screen, off it and back, a rearm, a restart: nothing asks the server again.
    reading.observe(at(2400), 2900);
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    reading.rearm();
    reading.restart();
    await flush();
    expect(open).toHaveBeenCalledOnce();
    expect(reach).not.toHaveBeenCalled();
    expect(onRefusal).toHaveBeenCalledOnce();
    expect(reading.state().end).toBe('outdated');
  });

  it('a refused stamp is final too, where any other failure would retry on the way back', async () => {
    const open = vi.fn(() => Promise.resolve(null));
    const reach = vi.fn(() => Promise.reject(OUTDATED));
    const onRefusal = vi.fn();
    const reading = createTermsReading({ open, reach, onRefusal, onChange: () => {} });
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    expect(reading.state().end).toBe('outdated');
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledOnce();
    expect(onRefusal).toHaveBeenCalledOnce();
  });
});

describe('a reading the server lost (terms_not_opened)', () => {
  const NOT_OPENED = new ConvexError({ code: 'terms_not_opened', message: 'Not opened.' });

  it('is said, opens anew from the top, and the end counts only when reached again', async () => {
    const open = vi.fn(() => Promise.resolve(null));
    const reach = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(NOT_OPENED)
      .mockResolvedValue(null);
    const onRefusal = vi.fn();
    const toTop = vi.fn();
    const reading = createTermsReading({ open, reach, onRefusal, onChange: () => {}, toTop });
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    // As on the web: the toast, a new reading, the reader at its top — and no stamp at once, so the
    // record can never say the terms were opened and finished in the same instant.
    expect(onRefusal).toHaveBeenCalledOnce();
    expect(toTop).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    expect(reach).toHaveBeenCalledOnce();
    expect(reading.state()).toEqual({ end: 'unseen', progress: 0 });
    // A report from before the scroll landed doesn't count; leaving and coming back does.
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledOnce();
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledTimes(2);
    expect(reading.state().end).toBe('recorded');
    expect(onRefusal).toHaveBeenCalledOnce();
  });

  it('a server that keeps refusing costs one toast per reading, never a loop', async () => {
    const open = vi.fn(() => Promise.resolve(null));
    const reach = vi.fn(() => Promise.reject(NOT_OPENED));
    const onRefusal = vi.fn();
    const reading = createTermsReading({ open, reach, onRefusal, onChange: () => {} });
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    reading.observe(at(2410), 2900);
    await flush();
    expect(reach).toHaveBeenCalledOnce();
    expect(onRefusal).toHaveBeenCalledOnce();
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledTimes(2);
    expect(onRefusal).toHaveBeenCalledTimes(2);
    expect(reading.state().end).toBe('unseen');
  });

  it('drops a refusal that a newer reading overtook', async () => {
    const first = deferred();
    const open = vi.fn(() => Promise.resolve(null));
    const reach = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(null);
    const onRefusal = vi.fn();
    const reading = createTermsReading({ open, reach, onRefusal, onChange: () => {} });
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    reading.restart();
    first.reject(NOT_OPENED);
    await flush();
    // The stale refusal neither restarted nor spoke; the restart's own opening is the only new one.
    expect(open).toHaveBeenCalledTimes(2);
    expect(reach).toHaveBeenCalledOnce();
    expect(onRefusal).not.toHaveBeenCalled();
  });
});

describe('a failed opening, tried again while the skater reads', () => {
  function failingOnce() {
    const time = clock();
    const open = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(null);
    const reach = vi.fn(() => Promise.resolve(null));
    const onRefusal = vi.fn();
    const onUnopened = vi.fn();
    const toTop = vi.fn();
    const reading = createTermsReading({
      open,
      reach,
      onRefusal,
      onUnopened,
      onChange: () => {},
      toTop,
      now: time.now,
    });
    return { reading, open, reach, onRefusal, onUnopened, toTop, time };
  }

  it('is tried again on the next scroll past the gap, quietly, so the end finds a reading', async () => {
    const { reading, open, reach, onRefusal, onUnopened, toTop, time } = failingOnce();
    reading.start();
    await flush();
    expect(onRefusal).toHaveBeenCalledOnce();
    // Scrolling inside the gap: no new try.
    time.pass(TERMS_OPEN_RETRY_GAP_MS - 1);
    reading.observe(at(400), 2900);
    expect(open).toHaveBeenCalledOnce();
    time.pass(1);
    reading.observe(at(800), 2900);
    expect(open).toHaveBeenCalledTimes(2);
    await flush();
    // Read on to the end: the retried opening is there, and the end is stamped on it.
    time.pass(60_000);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledOnce();
    expect(reading.state().end).toBe('recorded');
    expect(onUnopened).not.toHaveBeenCalled();
    expect(toTop).not.toHaveBeenCalled();
    expect(onRefusal).toHaveBeenCalledOnce();
  });

  it('a retry that fails too says nothing; the end, still unopened, says why and starts again', async () => {
    const { reading, open, reach, onRefusal, onUnopened, toTop, time } = failingOnce();
    open
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(null);
    reading.start();
    await flush();
    time.pass(TERMS_OPEN_RETRY_GAP_MS);
    reading.observe(at(800), 2900);
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(onRefusal).toHaveBeenCalledOnce();
    reading.observe(at(2400), 2900);
    await flush();
    expect(onUnopened).toHaveBeenCalledOnce();
    expect(toTop).toHaveBeenCalledOnce();
    expect(reach).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('a retry is said only when it is out of date, which is final', async () => {
    const outdated = failingOnce();
    outdated.open
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new ConvexError({ code: 'client_outdated', message: 'Out of date.' }));
    outdated.reading.start();
    await flush();
    outdated.time.pass(TERMS_OPEN_RETRY_GAP_MS);
    outdated.reading.observe(at(800), 2900);
    await flush();
    expect(outdated.onRefusal).toHaveBeenCalledTimes(2);
    expect(outdated.reading.state().end).toBe('outdated');
    // Final: no more tries.
    outdated.time.pass(TERMS_OPEN_RETRY_GAP_MS);
    outdated.reading.observe(at(900), 2900);
    expect(outdated.open).toHaveBeenCalledTimes(2);
  });

  it('an end with no opening because the account can’t act says the server’s words, once, and only that', async () => {
    const { reading, open, reach, onRefusal, onUnopened, toTop, time } = failingOnce();
    const SUSPENDED = new ConvexError('Account is suspended');
    open
      .mockReset()
      .mockRejectedValueOnce(SUSPENDED)
      .mockRejectedValueOnce(SUSPENDED)
      .mockResolvedValue(null);
    reading.start();
    await flush();
    expect(onRefusal).toHaveBeenCalledOnce();
    // A quiet retry, refused the same way: nothing said (nothing about where the skater goes changes).
    time.pass(TERMS_OPEN_RETRY_GAP_MS);
    reading.observe(at(800), 2900);
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(onRefusal).toHaveBeenCalledOnce();
    // The end: the server's words, and nothing else — no terms_not_opened, no restart, no opening.
    time.pass(TERMS_OPEN_RETRY_GAP_MS);
    reading.observe(at(2400), 2900);
    await flush();
    expect(onRefusal).toHaveBeenCalledTimes(2);
    expect(onRefusal).toHaveBeenLastCalledWith(SUSPENDED);
    expect(onUnopened).not.toHaveBeenCalled();
    expect(toTop).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    expect(reading.state().end).toBe('failed');
    reading.observe(at(2410), 2900);
    expect(open).toHaveBeenCalledTimes(2);
    // The suspension ends: off the end, a retry opens the reading, and the end counts on the way back.
    reading.observe(at(800), 2900);
    expect(open).toHaveBeenCalledTimes(3);
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledOnce();
    expect(reading.state().end).toBe('recorded');
    expect(onRefusal).toHaveBeenCalledTimes(2);
  });

  it('a retry still out when the end is reached never counts on it either', async () => {
    const { reading, open, reach, onUnopened, time } = failingOnce();
    const retried = deferred();
    open
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(retried.promise);
    reading.start();
    await flush();
    time.pass(TERMS_OPEN_RETRY_GAP_MS);
    reading.observe(at(800), 2900);
    expect(open).toHaveBeenCalledTimes(2);
    // The end reached while the retry is out: not counted, not said.
    reading.observe(at(2400), 2900);
    retried.resolve();
    await flush();
    expect(onUnopened).not.toHaveBeenCalled();
    // Answered, with the marker still on screen: still nothing; off screen and back, then stamped.
    reading.observe(at(2410), 2900);
    await flush();
    expect(reach).not.toHaveBeenCalled();
    reading.observe(at(0), 2900);
    reading.observe(at(2400), 2900);
    await flush();
    expect(reach).toHaveBeenCalledOnce();
    expect(reading.state().end).toBe('recorded');
  });

  it('a reading started again opens quietly: just told why, its failure waits for the end', async () => {
    const { reading, open, onRefusal, onUnopened, time } = failingOnce();
    open
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(null);
    reading.start();
    await flush();
    reading.observe(at(2400), 2900);
    await flush();
    // The end said why, and the new reading's opening failed too: nothing more is said for it.
    expect(onUnopened).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    expect(onRefusal).toHaveBeenCalledOnce();
    // Still retried as the skater reads.
    time.pass(TERMS_OPEN_RETRY_GAP_MS);
    reading.observe(at(400), 2900);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('is never tried, nor its end said, after the screen is gone', async () => {
    const { reading, open, onUnopened, toTop, time } = failingOnce();
    reading.start();
    await flush();
    reading.dispose();
    time.pass(TERMS_OPEN_RETRY_GAP_MS);
    reading.observe(at(800), 2900);
    reading.observe(at(2400), 2900);
    expect(open).toHaveBeenCalledOnce();
    expect(onUnopened).not.toHaveBeenCalled();
    expect(toTop).not.toHaveBeenCalled();
  });

  it('an opening refused as out of date with the end on screen is said once, and only stops', async () => {
    const opened = deferred();
    const onRefusal = vi.fn();
    const onUnopened = vi.fn();
    const reading = createTermsReading({
      open: () => opened.promise,
      reach: () => Promise.resolve(null),
      onRefusal,
      onUnopened,
      onChange: () => {},
    });
    reading.start();
    reading.observe(at(2400), 2900);
    opened.reject(new ConvexError({ code: 'client_outdated', message: 'Out of date.' }));
    await flush();
    expect(reading.state().end).toBe('outdated');
    expect(onRefusal).toHaveBeenCalledOnce();
    expect(onUnopened).not.toHaveBeenCalled();
  });
});
