import { render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ListEnd } from './list-end';

beforeAll(() => {
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe('ListEnd', () => {
  it('draws no tab while a stroke token reads empty — no NaN, no warning — and keeps its label', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, getByText } = render(<ListEnd>All 7</ListEnd>);
    expect(getByText('All 7')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="list-end-tab"]')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it('draws its tab once its measures are numbers', () => {
    const tokens: Record<string, string> = { '--stroke-hair': '1px', '--stroke-run': '3px' };
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      return new Proxy(style, {
        get(target, key) {
          if (key === 'getPropertyValue') {
            return (name: string) => tokens[name] ?? target.getPropertyValue(name);
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<ListEnd>All 7</ListEnd>);
    expect(container.querySelector('[data-slot="list-end-tab"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="list-end-terminal"]')).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  });
});
