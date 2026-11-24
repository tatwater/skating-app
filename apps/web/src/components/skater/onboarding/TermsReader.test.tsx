import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryScreen } from './EntryScreen';
import { readingRoot, TermsReader } from './TermsReader';

/** Every observer the reader makes, with its root, so a test can say what it saw. */
class Watcher {
  static all: Watcher[] = [];
  live = true;
  targets: Element[] = [];
  readonly root: Element | null;
  constructor(
    readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = (options?.root as Element | null | undefined) ?? null;
    Watcher.all.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    this.live = false;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  /** The end marker, wholly inside this observer's root. */
  see() {
    const target = this.targets[0] as Element;
    this.callback(
      [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

/** The layout's resize notices, fired by hand when the test flips the layout. */
class Layout {
  static all: Layout[] = [];
  live = true;
  constructor(readonly callback: ResizeObserverCallback) {
    Layout.all.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.live = false;
  }
  static resize() {
    for (const l of Layout.all) {
      if (l.live) l.callback([], l as unknown as ResizeObserver);
    }
  }
}

/**
 * jsdom lays nothing out: each box's scroll sizes come from the layout the test picks. On a desk the
 * reader's window scrolls and the page doesn't; on a phone the window lets go of its height (it
 * scrolls nothing) and the page scrolls.
 */
let layout: 'desk' | 'phone' = 'desk';
function sizes(el: HTMLElement): { scrollHeight: number; clientHeight: number } {
  const slot = el.dataset.slot;
  if (slot === 'scroll-area-viewport') {
    return layout === 'desk'
      ? { scrollHeight: 4000, clientHeight: 300 }
      : { scrollHeight: 4000, clientHeight: 4000 };
  }
  if (slot === 'entry-body') {
    return layout === 'desk'
      ? { scrollHeight: 900, clientHeight: 900 }
      : { scrollHeight: 4400, clientHeight: 700 };
  }
  return { scrollHeight: 0, clientHeight: 0 };
}

beforeAll(() => {
  if (!('getAnimations' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'getAnimations', { value: () => [] });
  }
  Element.prototype.scrollTo ??= () => {};
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return sizes(this).scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return sizes(this).clientHeight;
    },
  });
});

beforeEach(() => {
  Watcher.all = [];
  Layout.all = [];
  layout = 'desk';
  vi.stubGlobal('IntersectionObserver', Watcher);
  vi.stubGlobal('ResizeObserver', Layout);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
/** The observers still watching the inline end (the full-screen reader's never mounts here). */
const watching = () => Watcher.all.filter((w) => w.live);

function inScreen(onEnd: () => void) {
  return (
    <EntryScreen width="terms" head={null} actions={null} email={null} onSignOut={() => {}}>
      <TermsReader read={false} armed onEnd={onEnd} />
    </EntryScreen>
  );
}

describe('readingRoot', () => {
  it('is the window when it scrolls, else the page, and nothing before the page is known', () => {
    const own = document.createElement('div');
    own.dataset.slot = 'scroll-area-viewport';
    const page = document.createElement('div');
    page.dataset.slot = 'entry-body';
    layout = 'desk';
    expect(readingRoot(own, page)).toBe(own);
    layout = 'phone';
    expect(readingRoot(own, page)).toBe(page);
    expect(readingRoot(own, null)).toBeNull();
    expect(readingRoot(null, null)).toBeNull();
  });
});

describe('where the inline end is watched', () => {
  it('watches nothing on a phone-width mount until the page is known: never the window', () => {
    layout = 'phone';
    // No screen around it: no page to read in.
    render(<TermsReader read={false} armed onEnd={() => {}} />);
    expect(Watcher.all).toEqual([]);
  });

  it('watches the page on a phone, never the window that clips nothing', () => {
    layout = 'phone';
    render(inScreen(() => {}));
    expect(watching().map((w) => w.root)).toEqual([slot('entry-body')]);
    expect(Watcher.all.some((w) => w.root === slot('scroll-area-viewport'))).toBe(false);
  });

  it('re-roots when the layout flips from a desk to a phone, and the old root’s sighting never counts', () => {
    const onEnd = vi.fn();
    render(inScreen(onEnd));
    const desk = watching();
    expect(desk.map((w) => w.root)).toEqual([slot('scroll-area-viewport')]);
    // The card narrows: the window lets go of its height. Before the resize notice re-roots the
    // watch, the old observer — rooted at a window that now holds the whole text — reports the
    // end "in view". It must not count.
    layout = 'phone';
    act(() => desk[0]?.see());
    expect(onEnd).not.toHaveBeenCalled();
    act(() => Layout.resize());
    expect(watching().map((w) => w.root)).toEqual([slot('entry-body')]);
    // Scrolled to the end of the page: that counts.
    act(() => watching()[0]?.see());
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith('inline');
  });

  it('re-roots when the layout flips from a phone to a desk', () => {
    layout = 'phone';
    render(inScreen(() => {}));
    expect(watching().map((w) => w.root)).toEqual([slot('entry-body')]);
    layout = 'desk';
    act(() => Layout.resize());
    expect(watching().map((w) => w.root)).toEqual([slot('scroll-area-viewport')]);
  });
});
