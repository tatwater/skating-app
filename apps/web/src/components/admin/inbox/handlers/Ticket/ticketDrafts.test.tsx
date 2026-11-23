import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { forgetTicketDrafts, useTicketDraft } from './ticketDrafts';

afterEach(() => forgetTicketDrafts());

/** **A ticket's draft and its send bracket**, as the store keeps them across handlers (R13-1). */
describe('the ticket’s send bracket', () => {
  it('one send out per ticket: a second begin sends nothing until the first ends', () => {
    const a = renderHook(() => useTicketDraft('t1'));
    const b = renderHook(() => useTicketDraft('t1'));
    act(() => a.result.current.setText('Hello'));
    let key: string | null = null;
    act(() => {
      key = a.result.current.beginSend('reply', 'Hello');
    });
    expect(key).not.toBeNull();
    // Another handler on the same ticket (a remount) sees it busy and can't begin.
    expect(b.result.current.draft.sending).toBe(true);
    expect(b.result.current.beginSend('reply', 'Hello')).toBeNull();
    // Another ticket is its own.
    const other = renderHook(() => useTicketDraft('t2'));
    expect(other.result.current.draft.sending).toBe(false);
  });

  it('landed clears only the words that went; anything typed since stays', () => {
    const d = renderHook(() => useTicketDraft('t1'));
    act(() => d.result.current.setText('  Sent words  '));
    act(() => void d.result.current.beginSend('reply', 'Sent words'));
    act(() => d.result.current.setText('Sent words, and more'));
    act(() => d.result.current.endSend(true));
    expect(d.result.current.draft).toMatchObject({ text: 'Sent words, and more', sending: false });
    act(() => void d.result.current.beginSend('reply', 'Sent words, and more'));
    act(() => d.result.current.endSend(true));
    expect(d.result.current.draft.text).toBe('');
  });

  it('a refused press keeps its words and key for the same press; a landed one forgets the key', () => {
    const d = renderHook(() => useTicketDraft('t1'));
    act(() => d.result.current.setText('Retry me'));
    let k1: string | null = null;
    let k2: string | null = null;
    let k3: string | null = null;
    act(() => {
      k1 = d.result.current.beginSend('reply', 'Retry me');
    });
    act(() => d.result.current.endSend(false));
    expect(d.result.current.draft.text).toBe('Retry me');
    act(() => {
      k2 = d.result.current.beginSend('reply', 'Retry me');
    });
    expect(k2).toBe(k1);
    act(() => d.result.current.endSend(true));
    act(() => d.result.current.setText('Retry me'));
    act(() => {
      k3 = d.result.current.beginSend('reply', 'Retry me');
    });
    expect(k3).not.toBe(k1);
    // The same words as a note are another press.
    act(() => d.result.current.endSend(false));
    expect(d.result.current.beginSend('note', 'Retry me')).not.toBe(k3);
  });
});
