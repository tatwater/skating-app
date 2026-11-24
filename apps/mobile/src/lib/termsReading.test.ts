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
    const open = vi.fn(() => Promise.resolve(null));
    const reach = vi.fn(() => Promise.resolve(null));
    const onRefusal = vi.fn();
    const states: TermsReadingState[] = [];
    const reading = createTermsReading({
      open: () => open(),
      reach: () => reach(),
      onRefusal,
      onChange: (s) => states.push(s),
    });
    return { reading, open, reach, onRefusal, states };
  }

  it('opens, fills the hairline, and records the end once', async () => {
    const { reading, open, reach, states } = setup();
    reading.start();
    expect(open).toHaveBeenCalledTimes(1);
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

  it('waits for the opening before stamping the end', async () => {
    const opened = deferred();
    const reach = vi.fn(() => Promise.resolve(null));
    const reading = createTermsReading({
      open: () => opened.promise,
      reach,
      onRefusal: vi.fn(),
      onChange: () => {},
    });
    reading.start();
    reading.observe(at(0, 800, 500), 450);
    await flush();
    expect(reach).not.toHaveBeenCalled();
    opened.resolve();
    await flush();
    expect(reach).toHaveBeenCalledTimes(1);
    expect(reading.state().end).toBe('recorded');
  });

  it('a failed stamp is toasted, and tried again only when the end comes back on screen', async () => {
    const { reading, reach, onRefusal } = setup();
    reach.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    reading.start();
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

  it('a failed opening is toasted and asked again by the next stamp', async () => {
    const { reading, open, reach, onRefusal } = setup();
    open.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    reading.start();
    await flush();
    expect(onRefusal).toHaveBeenCalledTimes(1);
    reading.observe(at(2400), 2900);
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(reach).toHaveBeenCalledTimes(1);
    expect(reading.state().end).toBe('recorded');
  });

  it('rearm stamps again at once if the end is still on screen, opening anew', async () => {
    const { reading, open, reach } = setup();
    reading.start();
    reading.observe(at(2400), 2900);
    await flush();
    expect(reading.state().end).toBe('recorded');
    reading.rearm();
    expect(reading.state().end).toBe('recording');
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(reach).toHaveBeenCalledTimes(2);
    expect(reading.state().end).toBe('recorded');
  });

  it('rearm away from the end waits for the scroll', async () => {
    const { reading, reach } = setup();
    reading.start();
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
    reading.observe(at(2400), 2900);
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

  it('an opening that fails after a newer one began does not forget the newer one', async () => {
    const first = deferred();
    const open = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(null);
    const reading = createTermsReading({
      open,
      reach: () => Promise.resolve(null),
      onRefusal: vi.fn(),
      onChange: () => {},
    });
    reading.start();
    reading.rearm();
    reading.observe(at(2400), 2900);
    first.reject(new Error('late'));
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
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
