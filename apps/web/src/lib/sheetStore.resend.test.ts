import { type PostDraft, type PostSheet, postSheetForEdit } from '@skating/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sheetPhotoPreview, whenSheetPhotosSettled } from './sheetPhotos';
import {
  bindSheetOwner,
  forgetSheet,
  getSheetAttempt,
  getSheetResend,
  readStoredSheet,
  resendSheet,
  resetSheetStoreForTests,
  restoreStoredSheet,
  type SheetSendOutcome,
  sendSheet,
  setSheet,
  setSheetAttempt,
  updateSheet,
  useSheetResend,
} from './sheetStore';
import {
  installFakeStore,
  mint,
  openSheet,
  pickPhoto,
  reloadPage,
  stubObjectUrls,
} from './sheetStore.fixtures';

vi.mock('../components/photoPipeline', () => import('./sheetPhotoPipeline.fake'));

const KEY = 'skating.reportSheet.v2';

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
const landed = vi.fn(async () => POSTED);

/** A sheet whose *Post* failed offline: the state a reconnect finds. */
function failedOffline(title = 'As pressed') {
  const post = { ...openSheet(), title };
  setSheet(post);
  setSheetAttempt(attemptAt(post));
  return post;
}

let fake: ReturnType<typeof installFakeStore>;

beforeEach(async () => {
  await whenSheetPhotosSettled();
  stubObjectUrls();
  fake = installFakeStore();
  bindSheetOwner('user_a');
  landed.mockClear();
});

afterEach(() => {
  resetSheetStoreForTests();
  window.localStorage.clear();
});

describe('what the attempt says about resending', () => {
  it('nothing open, or no attempt, is not waiting for anything', () => {
    expect(getSheetResend()).toBe('none');
    setSheet(openSheet());
    expect(getSheetResend()).toBe('none');
  });

  it('a transient failure waits, whether before the create or after it was sent', () => {
    for (const patch of [
      { status: 'pending' as const },
      { status: 'creating' as const },
      { status: 'pending' as const, postId: 'post-1' },
    ]) {
      const post = openSheet();
      setSheet(post);
      setSheetAttempt(attemptAt(post, patch));
      expect(getSheetResend()).toBe('waiting');
    }
  });

  it('a parked refusal does not — it needs the author, not a connection', () => {
    const post = openSheet();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'error', errorMessage: 'Too old to post.' }));
    expect(getSheetResend()).toBe('none');
  });

  it('clearing the attempt, or closing the sheet, stops waiting', () => {
    failedOffline();
    setSheetAttempt(null);
    expect(getSheetResend()).toBe('none');
    failedOffline();
    setSheet(null);
    expect(getSheetResend()).toBe('none');
  });

  it('an edit is never resent, whatever its attempt says', () => {
    const edit = postSheetForEdit(
      { reportId: 'r', waterBodyId: 'wb1', skateEndTime: Date.now(), photoIds: [] },
      null,
      Date.now(),
      mint,
    );
    setSheet(edit);
    setSheetAttempt(attemptAt(edit));
    expect(getSheetResend()).toBe('none');
  });
});

/** The rule that makes this safe to do unattended: what goes out is what the author pressed. */
describe('a change disarms it', () => {
  it('an edit after the failure stops the resend, and *Post* is the author’s again', async () => {
    failedOffline();
    updateSheet((p) => ({ ...p, title: 'Still writing', dirty: true }));
    expect(getSheetResend()).toBe('none');
    await expect(resendSheet(landed)).resolves.toEqual({ kind: 'skipped' });
    expect(landed).not.toHaveBeenCalled();
    expect(readStoredSheet(Date.now())?.resendArmed).toBe(false);
  });

  it('pressing *Post* again re-arms it, for the sheet as it now stands', async () => {
    const post = failedOffline();
    updateSheet((p) => ({ ...p, title: 'Second try' }));
    setSheetAttempt(attemptAt(post));
    expect(getSheetResend()).toBe('waiting');
    await resendSheet(landed);
    expect((landed.mock.calls[0] as unknown[])[0]).toMatchObject({ title: 'Second try' });
  });

  it('an update that changes nothing does not disarm it', () => {
    failedOffline();
    updateSheet((p) => p);
    expect(getSheetResend()).toBe('waiting');
  });

  it('a sent Post takes no change, so nothing can disarm it', () => {
    const post = openSheet();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'creating' }));
    updateSheet((p) => ({ ...p, title: 'Refused' }));
    expect(getSheetResend()).toBe('waiting');
  });
});

describe('resending', () => {
  it('sends the sheet and the attempt to resume from', async () => {
    const post = failedOffline();
    const previous = getSheetAttempt();
    await resendSheet(landed);
    expect(landed).toHaveBeenCalledWith(post, previous);
  });

  it('a landed Post closes the sheet and forgets it everywhere', async () => {
    failedOffline();
    const photo = await pickPhotoThenFail();
    const result = await resendSheet(landed);
    expect(result).toEqual(POSTED);
    expect(getSheetResend()).toBe('none');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(sheetPhotoPreview(photo)).toBeNull();
    await whenSheetPhotosSettled();
    expect(fake.rows.size).toBe(0);
  });

  it('a transient failure records the attempt and keeps waiting', async () => {
    const post = failedOffline();
    const draft = attemptAt(post, { status: 'creating' });
    const result = await resendSheet(async () => ({
      kind: 'refused',
      message: 'No connection.',
      draft,
    }));
    expect(result).toEqual({ kind: 'refused', message: 'No connection.' });
    expect(getSheetAttempt()).toEqual(draft);
    expect(getSheetResend()).toBe('waiting');
  });

  it('a permanent refusal parks it, with the words on the attempt', async () => {
    const post = failedOffline();
    const draft = attemptAt(post, { status: 'error', errorMessage: 'Too old to post.' });
    await resendSheet(async () => ({ kind: 'refused', message: 'Too old to post.', draft }));
    expect(getSheetResend()).toBe('none');
    expect(getSheetAttempt()?.errorMessage).toBe('Too old to post.');
  });

  it('a send that throws is a refusal, and the attempt stands', async () => {
    failedOffline();
    const before = getSheetAttempt();
    const result = await resendSheet(async () => {
      throw new Error('Boom');
    });
    expect(result).toEqual({ kind: 'refused', message: 'Boom' });
    expect(getSheetAttempt()).toBe(before);
    expect(getSheetResend()).toBe('waiting');
    const notAnError = await resendSheet(() => Promise.reject('plain'));
    expect(notAnError).toEqual({ kind: 'refused', message: 'plain' });
  });

  it('skips with nothing waiting, and sendSheet skips with nothing open', async () => {
    await expect(resendSheet(landed)).resolves.toEqual({ kind: 'skipped' });
    await expect(sendSheet(landed)).resolves.toEqual({ kind: 'skipped' });
    expect(landed).not.toHaveBeenCalled();
  });

  it('sendSheet is *Post* itself: it needs no earlier failure, and refuses an edit', async () => {
    setSheet(openSheet());
    await expect(sendSheet(landed)).resolves.toEqual(POSTED);
    setSheet(
      postSheetForEdit(
        { reportId: 'r', waterBodyId: 'wb1', skateEndTime: Date.now(), photoIds: [] },
        null,
        Date.now(),
        mint,
      ),
    );
    await expect(sendSheet(landed)).resolves.toEqual({ kind: 'skipped' });
  });
});

async function pickPhotoThenFail(): Promise<string> {
  const photo = await pickPhoto({ pool: true });
  const post = readStoredSheet(Date.now())?.sheet as PostSheet;
  setSheetAttempt(attemptAt(post));
  await whenSheetPhotosSettled();
  return photo.id;
}

/** A send held open, so a test can do things while it is out. */
function heldSend() {
  let answer: (outcome: SheetSendOutcome) => void = () => {};
  const send = vi.fn(
    () =>
      new Promise<SheetSendOutcome>((resolve) => {
        answer = resolve;
      }),
  );
  return { send, answer: (outcome: SheetSendOutcome) => answer(outcome) };
}

describe('one send at a time', () => {
  it('a reconnect that fires twice sends once, and a manual press does not double it', async () => {
    failedOffline();
    const { send, answer } = heldSend();
    const first = resendSheet(send);
    expect(getSheetResend()).toBe('sending');
    await expect(resendSheet(send)).resolves.toEqual({ kind: 'skipped' });
    await expect(sendSheet(send)).resolves.toEqual({ kind: 'skipped' });
    expect(send).toHaveBeenCalledTimes(1);
    answer(POSTED);
    await expect(first).resolves.toEqual(POSTED);
  });

  it('takes no change while it is out — it would close with the sheet', async () => {
    const post = failedOffline('As sent');
    const { send, answer } = heldSend();
    const flight = resendSheet(send);
    updateSheet((p) => ({ ...p, title: 'Typed meanwhile' }));
    expect(readStoredSheet(Date.now())?.sheet.title).toBe('As sent');
    answer({ kind: 'refused', message: 'No connection.', draft: attemptAt(post) });
    await flight;
    updateSheet((p) => ({ ...p, title: 'Typed after' }));
    expect(readStoredSheet(Date.now())?.sheet.title).toBe('Typed after');
  });

  it('an answer about a sheet since replaced leaves the new sheet alone', async () => {
    const post = failedOffline();
    const { send, answer } = heldSend();
    const flight = resendSheet(send);
    const next = { ...openSheet(), title: 'The new one' };
    setSheet(next);
    expect(getSheetResend()).toBe('none');
    updateSheet((p) => ({ ...p, dirty: true }));
    expect(readStoredSheet(Date.now())?.sheet.dirty).toBe(true);
    answer({ kind: 'refused', message: 'No connection.', draft: attemptAt(post) });
    await flight;
    expect(getSheetAttempt()).toBeNull();
    expect(readStoredSheet(Date.now())?.sheet.draftId).toBe(next.draftId);
  });

  it('a landed answer about a replaced sheet does not close the new one', async () => {
    failedOffline();
    const { send, answer } = heldSend();
    const flight = resendSheet(send);
    const next = openSheet();
    setSheet(next);
    answer(POSTED);
    await expect(flight).resolves.toEqual(POSTED);
    expect(readStoredSheet(Date.now())?.sheet.draftId).toBe(next.draftId);
  });

  it('an account change mid-send leaves the next account with nothing of it', async () => {
    const post = failedOffline();
    const { send, answer } = heldSend();
    const flight = resendSheet(send);
    bindSheetOwner('user_b');
    answer({ kind: 'refused', message: 'No connection.', draft: attemptAt(post) });
    await flight;
    expect(getSheetAttempt()).toBeNull();
    expect(getSheetResend()).toBe('none');
  });

  it('a sign-out mid-send stays signed out', async () => {
    failedOffline();
    const { send, answer } = heldSend();
    const flight = resendSheet(send);
    forgetSheet();
    answer(POSTED);
    await flight;
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('tells a subscriber each state as it goes', async () => {
    const { result } = renderHook(() => useSheetResend());
    expect(result.current).toBe('none');
    act(() => {
      failedOffline();
    });
    expect(result.current).toBe('waiting');
    const { send, answer } = heldSend();
    let flight: Promise<unknown> = Promise.resolve();
    act(() => {
      flight = resendSheet(send);
    });
    expect(result.current).toBe('sending');
    await act(async () => {
      answer(POSTED);
      await flight;
    });
    expect(result.current).toBe('none');
  });
});

/** The founder's comment read literally: it resends itself — across a reload too. */
describe('across a reload', () => {
  it('a Post waiting to send is still waiting, if the caller passes it on', async () => {
    failedOffline('As pressed');
    reloadPage('user_a');
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.resendArmed).toBe(true);
    setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
    expect(getSheetResend()).toBe('waiting');
    await resendSheet(landed);
    expect((landed.mock.calls[0] as unknown[])[0]).toMatchObject({ title: 'As pressed' });
  });

  it('a route that does not pass it on keeps today’s behavior: nothing goes out alone', async () => {
    failedOffline();
    reloadPage('user_a');
    const stored = readStoredSheet(Date.now());
    expect(stored?.resendArmed).toBe(true);
    setSheet(stored?.sheet ?? null, stored?.attempt ?? null);
    expect(getSheetResend()).toBe('none');
  });

  it('an edit made before the reload stays disarmed after it', async () => {
    failedOffline();
    updateSheet((p) => ({ ...p, title: 'Still writing' }));
    reloadPage('user_a');
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.resendArmed).toBe(false);
    setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
    expect(getSheetResend()).toBe('none');
  });

  it('a restore that brought every photo back stays armed', async () => {
    failedOffline();
    await pickPhotoThenFail();
    reloadPage('user_a');
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.photosLost).toBe(0);
    expect(restored?.resendArmed).toBe(true);
  });

  /** A Post that quietly went out without the photo the author attached is worse than one that waited. */
  it('a restore that lost a photo disarms an unsent Post', async () => {
    failedOffline();
    await pickPhotoThenFail();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    fake.rows.clear();
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.photosLost).toBe(1);
    expect(restored?.resendArmed).toBe(false);
    setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
    expect(getSheetResend()).toBe('none');
  });

  it('the synchronous read, which never brings photos, disarms it the same way', async () => {
    failedOffline();
    await pickPhotoThenFail();
    expect(readStoredSheet(Date.now())?.resendArmed).toBe(false);
  });

  it('a sent Post stays armed even so: it cannot change, and only a retry finds out', async () => {
    const post = openSheet();
    setSheet(post);
    await pickPhoto({ pool: true });
    setSheetAttempt(attemptAt(post, { status: 'creating' }));
    await whenSheetPhotosSettled();
    reloadPage('user_a');
    await whenSheetPhotosSettled();
    fake.rows.clear();
    const restored = await restoreStoredSheet(Date.now());
    expect(restored?.photosLost).toBe(1);
    expect(restored?.resendArmed).toBe(true);
  });

  it('a stored flag over a parked attempt is not a resend', async () => {
    const post = openSheet();
    setSheet(post);
    setSheetAttempt(attemptAt(post, { status: 'error' }));
    const raw = JSON.parse(window.localStorage.getItem(KEY) as string);
    window.localStorage.setItem(KEY, JSON.stringify({ ...raw, resendArmed: true }));
    reloadPage('user_a');
    const restored = await restoreStoredSheet(Date.now());
    setSheet(restored?.sheet ?? null, restored?.attempt ?? null, restored?.resendArmed);
    expect(getSheetResend()).toBe('none');
  });

  it('never reaches another account', async () => {
    failedOffline();
    reloadPage('user_b');
    await expect(restoreStoredSheet(Date.now())).resolves.toBeNull();
    expect(getSheetResend()).toBe('none');
    await expect(resendSheet(landed)).resolves.toEqual({ kind: 'skipped' });
    expect(landed).not.toHaveBeenCalled();
  });
});
