import type { PostDraft, PostSheet } from '@skating/core';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
  sheet: null as unknown,
  attempt: null as unknown,
  stored: null as unknown,
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => m.signOut }));
vi.mock('@/lib/sheetStore', () => ({
  useSheet: () => m.sheet,
  useSheetAttempt: () => m.attempt,
  readStoredSheet: () => m.stored,
}));

import { BOARD_NOON } from '@/test/boardNow';
import { SignOutDialog, startedLabel, unsentDraft } from './SignOutGuard';
import { useGuardedSignOut } from './useGuardedSignOut';

const NOON = BOARD_NOON;

function sheet(over: Partial<PostSheet> = {}): PostSheet {
  return {
    draftId: 'd1',
    idempotencyKey: 'k1',
    title: '',
    body: '',
    reports: [
      {
        id: 'r1',
        idempotencyKey: 'rk1',
        sheet: {} as never,
        bodyName: 'Mascoma Lake',
        photos: [],
        keptPhotoIds: [],
        bundleCandidateIds: [],
        unbundledHazardIds: [],
      },
    ],
    mode: { kind: 'create' },
    door: 'body',
    openedAtMs: new Date(2027, 0, 16, 11, 52).getTime(),
    dirty: true,
    ...over,
  };
}

beforeEach(() => {
  m.signOut.mockClear();
  m.sheet = null;
  m.attempt = null;
  m.stored = null;
});

describe('unsentDraft', () => {
  it('is nothing without a sheet, or with an untouched one and no attempt', () => {
    expect(unsentDraft(null, null)).toBeNull();
    expect(unsentDraft(sheet({ dirty: false }), null)).toBeNull();
  });

  it('names the lake and the start, for a written-in sheet or a failed attempt', () => {
    expect(unsentDraft(sheet(), null)).toEqual({
      label: 'Mascoma Lake',
      openedAtMs: sheet().openedAtMs,
      post: 'new',
    });
    expect(unsentDraft(sheet({ dirty: false }), {} as PostDraft)?.label).toBe('Mascoma Lake');
    expect(
      unsentDraft(sheet({ mode: { kind: 'edit', reportId: 'rep9' }, title: 'East shore' }), null),
    ).toMatchObject({ label: 'East shore', post: 'rep9' });
  });
});

describe('startedLabel', () => {
  it('reads today, yesterday, then the date', () => {
    expect(startedLabel(new Date(2027, 0, 16, 11, 52).getTime(), NOON)).toBe('today at 11:52 AM');
    expect(startedLabel(new Date(2027, 0, 15, 16, 5).getTime(), NOON)).toBe('yesterday at 4:05 PM');
    expect(startedLabel(new Date(2027, 0, 9, 9, 0).getTime(), NOON)).toBe(
      'on January 9 at 9:00 AM',
    );
    expect(startedLabel(Date.UTC(2027, 0, 16, 16, 52), Date.UTC(2027, 0, 16, 17), 'UTC')).toBe(
      'today at 4:52 PM',
    );
  });
});

describe('useGuardedSignOut', () => {
  it('signs straight out when nothing would be lost', async () => {
    const { result } = renderHook(() => useGuardedSignOut());
    await act(async () => result.current.request());
    expect(m.signOut).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
  });

  it('asks first when the open sheet holds a draft, and signs out on the confirm', async () => {
    m.sheet = sheet();
    const { result } = renderHook(() => useGuardedSignOut());
    act(() => result.current.request());
    expect(m.signOut).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);
    expect(result.current.dialog.draft?.label).toBe('Mascoma Lake');
    await act(async () => result.current.dialog.onSignOut());
    expect(m.signOut).toHaveBeenCalledTimes(1);
  });

  it('finds a draft a reload left in storage', () => {
    m.stored = { sheet: sheet(), attempt: null, resendArmed: false };
    const { result } = renderHook(() => useGuardedSignOut());
    act(() => result.current.request());
    expect(result.current.open).toBe(true);
    act(() => result.current.dialog.onOpenChange(true));
    expect(result.current.open).toBe(true);
    act(() => result.current.dialog.onOpenChange(false));
    expect(result.current.open).toBe(false);
  });

  it('a stored sheet with nothing written signs straight out', async () => {
    m.stored = { sheet: sheet({ dirty: false }), attempt: null, resendArmed: false };
    const { result } = renderHook(() => useGuardedSignOut());
    await act(async () => result.current.request());
    expect(m.signOut).toHaveBeenCalledTimes(1);
  });

  it('a failed sign-out still clears the busy state', async () => {
    m.signOut.mockRejectedValueOnce(new Error('offline'));
    m.sheet = sheet();
    const { result } = renderHook(() => useGuardedSignOut());
    act(() => result.current.request());
    await act(async () => {
      result.current.dialog.onSignOut();
      await Promise.resolve();
    });
    expect(result.current.dialog.busy).toBe(false);
  });
});

describe('SignOutDialog', () => {
  it('says what is lost and offers the draft, Cancel, and a red Sign out', () => {
    const onSignOut = vi.fn();
    const onOpenDraft = vi.fn();
    const onOpenChange = vi.fn();
    const draft = unsentDraft(sheet(), null);
    render(
      <SignOutDialog
        draft={draft}
        busy={false}
        now={NOON}
        onOpenChange={onOpenChange}
        onSignOut={onSignOut}
        onOpenDraft={onOpenDraft}
      />,
    );
    expect(screen.getByText('Sign out and discard your draft?')).toBeInTheDocument();
    expect(
      screen.getByText(/unsent report on Mascoma Lake, started today at 11:52 AM/),
    ).toBeInTheDocument();
    const out = screen.getByRole('button', { name: 'Sign out' });
    expect(out).toHaveAttribute('data-armed');
    fireEvent.click(screen.getByRole('button', { name: 'Open the draft' }));
    expect(onOpenDraft).toHaveBeenCalledWith(draft);
    fireEvent.click(out);
    expect(onSignOut).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it('draws nothing without a draft', () => {
    render(
      <SignOutDialog
        draft={null}
        busy={false}
        onOpenChange={() => {}}
        onSignOut={() => {}}
        onOpenDraft={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
