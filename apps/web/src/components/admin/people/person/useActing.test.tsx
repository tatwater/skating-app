import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { keepFocus, useActing } from './useActing';

afterEach(() => {
  document.body.innerHTML = '';
});

function region() {
  const el = document.createElement('section');
  el.tabIndex = -1;
  el.innerHTML = `
    <button data-lever-button="lift">Lift</button>
    <button data-lever-button="ban">Ban</button>`;
  document.body.append(el);
  return el;
}

describe('keepFocus', () => {
  it('leaves focus alone when it is already in the block', () => {
    const r = region();
    const ban = r.querySelector<HTMLElement>('[data-lever-button="ban"]');
    ban?.focus();
    keepFocus(r, null, 'lift');
    expect(document.activeElement).toBe(ban);
  });

  it('goes back to what held it before, while it is still on the page', () => {
    const r = region();
    const ban = r.querySelector<HTMLElement>('[data-lever-button="ban"]') as HTMLElement;
    (document.activeElement as HTMLElement | null)?.blur();
    keepFocus(r, ban, 'lift');
    expect(document.activeElement).toBe(ban);
  });

  it('else to the lever’s button, else to the block', () => {
    const r = region();
    const gone = document.createElement('button');
    keepFocus(r, gone, 'lift');
    expect(document.activeElement).toBe(r.querySelector('[data-lever-button="lift"]'));
    (document.activeElement as HTMLElement).blur();
    keepFocus(r, null, 'nothing');
    expect(document.activeElement).toBe(r);
  });

  it('does nothing without a block', () => {
    expect(() => keepFocus(null, null, 'x')).not.toThrow();
  });
});

describe('useActing', () => {
  it('a write that throws is said, never swallowed', async () => {
    const onAct = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() => useActing(onAct));
    let refused: string | null = null;
    await act(async () => {
      refused = await result.current.act('lift', { kind: 'lift' }, { region: null, inline: true });
    });
    expect(refused).toBe('Something went wrong — check your connection and try again.');
    expect(result.current.refusals).toEqual({
      lift: 'Something went wrong — check your connection and try again.',
    });
    expect(result.current.busy).toBeNull();
  });

  it('a dialog’s refusal stays with the dialog, not the row', async () => {
    const { result } = renderHook(() => useActing(async () => 'No'));
    await act(async () => {
      await result.current.act(
        'ban',
        { kind: 'ban', reason: 'x' },
        { region: null, inline: false },
      );
    });
    expect(result.current.refusals).toEqual({});
  });

  it('a new try clears the last refusal', async () => {
    let answer: string | null = 'No';
    const { result } = renderHook(() => useActing(async () => answer));
    await act(async () => {
      await result.current.act('lift', { kind: 'lift' }, { region: null, inline: true });
    });
    expect(result.current.refusals).toEqual({ lift: 'No' });
    answer = null;
    await act(async () => {
      await result.current.act('lift', { kind: 'lift' }, { region: null, inline: true });
    });
    expect(result.current.refusals).toEqual({});
  });
});
