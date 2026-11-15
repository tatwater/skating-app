/**
 * Test support: what jsdom lacks that the kit's list end and notes reach for on mount — the font
 * set's `ready` (the list-end tab fits itself to its label once fonts load) and Web Animations.
 * Defined only where missing, so a real browser's stay.
 */
export function stubLayout(): void {
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
    ['scrollIntoView', () => {}],
  ] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value });
    }
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
}

/**
 * Test support: a list viewport as tall as `height` — jsdom lays nothing out, so every scroller
 * measures zero, which the load-ahead rule reads as out of sight. `show(h)` changes the height and
 * tells every observer, as a browser does when a hidden pane is shown. Call in `beforeEach`; it
 * restores itself through `vi.restoreAllMocks`.
 */
export function measureViewports(
  spyOn: typeof import('vitest').vi.spyOn,
  height = 600,
): { show: (h: number) => void } {
  let current = height;
  spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => current);
  const observers = new Set<() => void>();
  spyOn(globalThis, 'ResizeObserver').mockImplementation(function (
    this: unknown,
    callback: ResizeObserverCallback,
  ) {
    return {
      observe: () => observers.add(() => callback([], {} as ResizeObserver)),
      unobserve: () => {},
      disconnect: () => {},
    } as unknown as ResizeObserver;
  } as never);
  return {
    show: (h: number) => {
      current = h;
      for (const notify of [...observers]) notify();
    },
  };
}
