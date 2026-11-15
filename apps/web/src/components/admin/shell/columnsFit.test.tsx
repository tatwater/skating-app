import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useColumnsFit } from './columnsFit';

afterEach(() => vi.restoreAllMocks());

/** Tokens as a surface would resolve them, and the box's measured width. */
function measure(width: number, tokens: Record<string, string>) {
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
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
  } as DOMRect);
}

function Probe({ onFits }: { onFits: (fits: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  onFits(useColumnsFit(ref, ['--a', '--b']));
  return <div ref={ref} />;
}

describe('useColumnsFit', () => {
  const TOKENS = { '--a': '14.75rem', '--b': '21.25rem' }; // 576 px together

  it('keeps the columns while their token widths fit side by side', () => {
    measure(576, TOKENS);
    let fits: boolean | undefined;
    render(<Probe onFits={(f) => (fits = f)} />);
    expect(fits).toBe(true);
  });

  it('turns master–detail below their sum', () => {
    measure(326, TOKENS);
    let fits: boolean | undefined;
    render(<Probe onFits={(f) => (fits = f)} />);
    expect(fits).toBe(false);
  });

  it('assumes they fit before a box is measured, or while a token hasn’t resolved', () => {
    measure(0, TOKENS);
    let fits: boolean | undefined;
    const { unmount } = render(<Probe onFits={(f) => (fits = f)} />);
    expect(fits).toBe(true);
    unmount();
    vi.restoreAllMocks();
    measure(326, {});
    render(<Probe onFits={(f) => (fits = f)} />);
    expect(fits).toBe(true);
  });
});
