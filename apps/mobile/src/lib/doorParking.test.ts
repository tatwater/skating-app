import type { PostSheet } from '@skating/core';
import { describe, expect, it, vi } from 'vitest';
import { EDIT_HELD_MESSAGE, parkForNewDoor } from './doorParking';

const sheet = (dirty: boolean, kind: 'create' | 'edit') =>
  ({ dirty, mode: { kind } }) as unknown as PostSheet;

describe('parkForNewDoor', () => {
  it('lets the door open when nothing is open or nothing is unsaved, without saving', async () => {
    const save = vi.fn(async () => {});
    expect(await parkForNewDoor(null, 1, save)).toEqual({ kind: 'clear' });
    expect(await parkForNewDoor(sheet(false, 'create'), 1, save)).toEqual({ kind: 'clear' });
    expect(await parkForNewDoor(sheet(false, 'edit'), 1, save)).toEqual({ kind: 'clear' });
    expect(save).not.toHaveBeenCalled();
  });

  it('parks an unsaved new report in Drafts, then lets the door open', async () => {
    const save = vi.fn(async () => {});
    const open = sheet(true, 'create');
    expect(await parkForNewDoor(open, 42, save)).toEqual({ kind: 'clear' });
    expect(save).toHaveBeenCalledWith(open, 42);
  });

  it('keeps an unsaved edit of a published report on screen — Drafts cannot hold it', async () => {
    const save = vi.fn(async () => {});
    expect(await parkForNewDoor(sheet(true, 'edit'), 1, save)).toEqual({
      kind: 'held',
      message: EDIT_HELD_MESSAGE,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps an unsaved new report on screen when parking it fails, and says why', async () => {
    const save = vi.fn(async () => {
      throw new Error('This post is sending right now — try again in a moment.');
    });
    const result = await parkForNewDoor(sheet(true, 'create'), 1, save);
    expect(result.kind).toBe('held');
    expect(result.kind === 'held' && result.message).toMatch(/sending right now/);
  });
});
