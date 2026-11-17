import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useColumnsFit, usePaneFocus } from './columnsFit';

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

  it('measures again as the box resizes, either way, and stops when it goes', () => {
    let resized: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      measure(576, TOKENS);
      let fits: boolean | undefined;
      const { unmount } = render(<Probe onFits={(f) => (fits = f)} />);
      expect(fits).toBe(true);
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
        width: 575,
      } as DOMRect);
      act(() => resized?.());
      expect(fits).toBe(false);
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
        width: 1024,
      } as DOMRect);
      act(() => resized?.());
      expect(fits).toBe(true);
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Three panes, one at a time (the Body console's narrow rule): the list is `body`, and either of two
 * panes may be the detail. Focus in a pane the rule just hid moves to the one now shown — from the
 * list to a detail, from one detail to the other, and back to the list.
 */
function ThreePanes({ at }: { at: 'body' | 'map' | 'tab' }) {
  const page = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLElement>(null);
  const panes = usePaneFocus({
    page,
    shown: at === 'body' ? 'list' : 'detail',
    open: true,
    focusList: () => body.current?.focus(),
    detailPane: at === 'map' ? 'map' : 'inspector',
    listPanes: ['body'],
  });
  return (
    <div ref={page} {...panes.pageProps}>
      <section ref={body} data-pane="body" tabIndex={-1} hidden={at !== 'body'}>
        <button type="button">In the body</button>
      </section>
      <div data-pane="map" tabIndex={-1} hidden={at !== 'map'}>
        <button type="button">In the map</button>
      </div>
      <div data-pane="inspector" tabIndex={-1} hidden={at !== 'tab'}>
        <button type="button">In the tab</button>
      </div>
    </div>
  );
}

describe('usePaneFocus over three panes', () => {
  const pane = (name: string) => document.querySelector<HTMLElement>(`[data-pane="${name}"]`);

  it('moves focus from a hidden pane to the one shown, detail to detail included', () => {
    const { rerender } = render(<ThreePanes at="body" />);
    act(() => screen.getByRole('button', { name: 'In the body' }).focus());
    rerender(<ThreePanes at="map" />);
    expect(pane('map')).toHaveFocus();
    act(() => screen.getByRole('button', { name: 'In the map' }).focus());
    rerender(<ThreePanes at="tab" />);
    expect(pane('inspector')).toHaveFocus();
    rerender(<ThreePanes at="body" />);
    expect(pane('body')).toHaveFocus();
  });

  it('leaves focus that is in the pane still shown where it is', () => {
    const { rerender } = render(<ThreePanes at="tab" />);
    const inTab = screen.getByRole('button', { name: 'In the tab' });
    act(() => inTab.focus());
    rerender(<ThreePanes at="tab" />);
    expect(inTab).toHaveFocus();
  });
});
