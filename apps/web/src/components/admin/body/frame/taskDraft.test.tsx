import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { heldEngine, useTaskDraft } from './taskDraft';

/** A map task's draft held still while its save is out (`useTaskDraft`). */
describe('useTaskDraft', () => {
  it('edits the draft, and ignores an edit while a save is out, even in the same tick', () => {
    const { result } = renderHook(() => useTaskDraft<{ name: string }>());
    act(() => result.current.edit((d) => ({ ...d, name: 'x' })));
    // No draft: an edit has nothing to change.
    expect(result.current.draft).toBeNull();
    act(() => result.current.setDraft({ name: 'a' }));
    act(() => result.current.edit((d) => ({ ...d, name: 'b' })));
    expect(result.current.draft).toEqual({ name: 'b' });
    act(() => {
      result.current.setSaving(true);
      // Before `saving` renders: the ref refuses it already.
      result.current.edit((d) => ({ ...d, name: 'c' }));
    });
    expect(result.current.saving).toBe(true);
    expect(result.current.draft).toEqual({ name: 'b' });
    // The task's own transitions still go through.
    act(() => result.current.setDraft(null));
    expect(result.current.draft).toBeNull();
    act(() => {
      result.current.setSaving(false);
      result.current.setDraft({ name: 'd' });
    });
    act(() => result.current.edit((d) => ({ ...d, name: 'e' })));
    expect(result.current).toMatchObject({ saving: false, draft: { name: 'e' } });
  });

  it('stands the engine down while saving', () => {
    const engine = { kind: 'point', onPick: () => {} } as const;
    expect(heldEngine(true, engine)).toEqual({ kind: 'none' });
    expect(heldEngine(false, engine)).toBe(engine);
  });
});
