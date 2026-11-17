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
  /** A refusal is its toast's (said by the write path, D268): the hook keeps no words of it. */
  it.each([
    ['refused', async () => false],
    [
      'a write path that threw',
      async () => {
        throw new Error('offline');
      },
    ],
  ])('%s: the press hears only "refused", and nothing is kept to print', async (_, answer) => {
    const { result } = renderHook(() => useActing(vi.fn(answer)));
    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.act('lift', { kind: 'lift' }, { region: null, inline: true });
    });
    expect(outcome).toBe('refused');
    expect(result.current.waits.size).toBe(0);
    expect(result.current.busy).toBeNull();
  });

  it('a landed write is "landed"', async () => {
    const { result } = renderHook(() => useActing(async () => true));
    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.act(
        'ban',
        { kind: 'ban', reason: 'x' },
        { region: null, inline: false },
      );
    });
    expect(outcome).toBe('landed');
  });

  it('a press while another change is out waits: the page’s own note, gone once that change settles', async () => {
    let settle: (landed: boolean) => void = () => {};
    const { result } = renderHook(() =>
      useActing(() => new Promise<boolean>((resolve) => (settle = resolve))),
    );
    let first: Promise<unknown> = Promise.resolve();
    let second: string | null = null;
    await act(async () => {
      first = result.current.act('lift', { kind: 'lift' }, { region: null, inline: true });
      second = await result.current.act(
        'ban',
        { kind: 'ban', reason: 'x' },
        { region: null, inline: true },
      );
    });
    expect(second).toBe('waiting');
    expect([...result.current.waits]).toEqual(['ban']);
    await act(async () => {
      settle(true);
      await first;
    });
    expect(result.current.waits.size).toBe(0);
  });
});
