import type { PostDraft, PostSheet } from '@skating/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenSheetPhotosSettled } from './sheetPhotos';
import { useResendOnReconnect } from './sheetReconnect';
import {
  bindSheetOwner,
  getSheet,
  getSheetResend,
  resetSheetStoreForTests,
  type SheetSendOutcome,
  sendSheet,
  setSheet,
  updateSheet,
} from './sheetStore';
import { installFakeStore, openSheet, stubObjectUrls } from './sheetStore.fixtures';
import type { ConnectionStatus } from './useConnection';

vi.mock('../components/photoPipeline', () => import('./sheetPhotoPipeline.fake'));

const connection = vi.hoisted(() => ({ status: 'online' as ConnectionStatus }));
vi.mock('./useConnection', () => ({ useConnection: () => ({ status: connection.status }) }));

function attemptAt(post: PostSheet, patch: Partial<PostDraft> = {}): PostDraft {
  return {
    kind: 'post',
    id: post.draftId,
    idempotencyKey: post.idempotencyKey,
    status: 'pending',
    reports: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const POSTED: SheetSendOutcome = { kind: 'posted', postId: 'post-1', reportId: 'report-1' };

/** *Post* pressed while the network was gone: the send itself answers a transient failure. */
async function pressPostOffline(): Promise<PostSheet> {
  const post = openSheet();
  setSheet(post);
  await sendSheet(async (p) => ({
    kind: 'refused',
    message: 'No connection.',
    draft: attemptAt(p),
  }));
  return post;
}

function mount(send: ReturnType<typeof vi.fn>, onResult = vi.fn()) {
  const view = renderHook(() => useResendOnReconnect(send as never, onResult));
  const go = (status: ConnectionStatus) => {
    connection.status = status;
    act(() => view.rerender());
  };
  return { ...view, go, onResult };
}

beforeEach(async () => {
  await whenSheetPhotosSettled();
  stubObjectUrls();
  installFakeStore();
  bindSheetOwner('user_a');
  connection.status = 'online';
});

afterEach(() => {
  resetSheetStoreForTests();
  window.localStorage.clear();
});

describe('resending on reconnect', () => {
  it('an unedited Post that failed offline goes out when the connection comes back', async () => {
    const post = await pressPostOffline();
    expect(getSheetResend()).toBe('waiting');
    const send = vi.fn(async (_post: PostSheet, _attempt: PostDraft | null) => POSTED);
    const { go, onResult } = mount(send);
    go('offline');
    expect(send).not.toHaveBeenCalled();
    go('online');
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ ...POSTED, stillOpen: true }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(post);
    expect(getSheetResend()).toBe('none');
  });

  it('a Post edited after the failure stays put: *Post* is the author’s again', async () => {
    await pressPostOffline();
    updateSheet((p) => ({ ...p, title: 'Changed my mind' }));
    const send = vi.fn(async () => POSTED);
    const { go, onResult } = mount(send);
    go('connecting');
    go('online');
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('sends nothing on mount while already online — only the way into online fires it', async () => {
    await pressPostOffline();
    const send = vi.fn(async () => POSTED);
    const { go } = mount(send);
    go('online');
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(getSheetResend()).toBe('waiting');
  });

  it('a resend that fails transiently again reports it and keeps waiting for the next return', async () => {
    const post = await pressPostOffline();
    const send = vi.fn(async () => ({
      kind: 'refused' as const,
      message: 'Still no connection.',
      draft: attemptAt(post, { status: 'creating' }),
    }));
    const { go, onResult } = mount(send);
    go('offline');
    go('online');
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ kind: 'refused', message: 'Still no connection.' }),
    );
    expect(getSheetResend()).toBe('waiting');
  });

  describe('an answer that comes back after the author moved on', () => {
    function held() {
      let answer: (outcome: SheetSendOutcome) => void = () => {};
      const send = vi.fn(
        () =>
          new Promise<SheetSendOutcome>((resolve) => {
            answer = resolve;
          }),
      );
      return { send, answer: (outcome: SheetSendOutcome) => answer(outcome) };
    }

    it('a landed resend for a sheet since replaced is not handed on — the new draft stays', async () => {
      await pressPostOffline();
      const { send, answer } = held();
      const { go, onResult } = mount(send);
      go('offline');
      go('online');
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const next = { ...openSheet(), title: 'The new one' };
      setSheet(next);
      await act(async () => answer(POSTED));
      await whenSheetPhotosSettled();
      expect(onResult).not.toHaveBeenCalled();
      expect(getSheet()?.draftId).toBe(next.draftId);
    });

    it('a refused resend for a sheet since replaced is not handed on either', async () => {
      const post = await pressPostOffline();
      const { send, answer } = held();
      const { go, onResult } = mount(send);
      go('offline');
      go('online');
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      setSheet(openSheet());
      await act(async () =>
        answer({ kind: 'refused', message: 'No connection.', draft: attemptAt(post) }),
      );
      expect(onResult).not.toHaveBeenCalled();
    });

    it('a resend that lands after the console unmounted reaches no one', async () => {
      await pressPostOffline();
      const { send, answer } = held();
      const { go, onResult, unmount } = mount(send);
      go('offline');
      go('online');
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => answer(POSTED));
      expect(onResult).not.toHaveBeenCalled();
      expect(getSheet()).toBeNull();
    });

    it('a refused resend for the sheet still open is handed on', async () => {
      const post = await pressPostOffline();
      const { send, answer } = held();
      const { go, onResult } = mount(send);
      go('offline');
      go('online');
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await act(async () =>
        answer({ kind: 'refused', message: 'No connection.', draft: attemptAt(post) }),
      );
      expect(onResult).toHaveBeenCalledWith({ kind: 'refused', message: 'No connection.' });
    });
  });
});
