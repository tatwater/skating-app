import { vi } from 'vitest';

/**
 * A page measured at `width` pixels, with the console's column tokens resolved as a surface
 * resolves them — what `useColumnsFit` reads — so a jsdom test can render the narrow rule. jsdom
 * loads no stylesheet, so every token would otherwise read as unresolved (and the columns as
 * fitting). Undone by `vi.restoreAllMocks()`.
 */
export function measureAt(width: number): void {
  const tokens: Record<string, string> = {
    '--size-lanes': '14.75rem',
    '--size-list': '21.25rem',
    '--size-inspector': '23.75rem',
  };
  const real = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = real(el, pseudo);
    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') {
          return (name: string) => tokens[name] ?? target.getPropertyValue(name);
        }
        if (key === 'fontSize') return '16px';
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    // Read field by field: a DOMRect's sides are accessors on its prototype, which a spread drops.
    const r = rect.call(this);
    const { x, y, top, left, height } = r;
    return {
      x,
      y,
      top,
      left,
      height,
      width,
      right: left + width,
      bottom: r.bottom,
      toJSON: () => ({ x, y, top, left, height, width }),
    } as DOMRect;
  });
}

/** A phone's width: the narrowest the console is drawn at. */
export const PHONE_WIDTH = 360;
