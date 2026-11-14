/**
 * Test support: what jsdom lacks and the kit's skeletons and tooltips ask for — Web Animations and
 * font loading. Call it once from a test file's `beforeAll`. Test-only; nothing in the app imports it.
 */
export function stubJsdomAnimations(): void {
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
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
