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
