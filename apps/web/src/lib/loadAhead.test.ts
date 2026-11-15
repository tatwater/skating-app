import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOAD_AHEAD_PX, mayLoadAhead } from './loadAhead';

afterEach(() => vi.restoreAllMocks());

/** A scroller as a browser would measure it. */
function scroller(clientHeight: number, scrollHeight: number, scrollTop = 0): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: clientHeight });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight });
  el.scrollTop = scrollTop;
  return el;
}

describe('mayLoadAhead', () => {
  it('asks near the end of a list in sight', () => {
    expect(mayLoadAhead(scroller(600, 1000))).toBe(true);
    expect(mayLoadAhead(scroller(600, 600 + LOAD_AHEAD_PX + 1))).toBe(false);
  });

  it('never asks for a list out of sight or not yet measured, however near its end it reads', () => {
    expect(mayLoadAhead(scroller(0, 0))).toBe(false);
    expect(mayLoadAhead(null)).toBe(false);
  });

  it('never asks while the browser tab is in the background', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(mayLoadAhead(scroller(600, 1000))).toBe(false);
  });
});
