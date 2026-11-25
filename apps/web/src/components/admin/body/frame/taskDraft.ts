import { useCallback, useRef, useState } from 'react';

import type { MapToolEngine } from './mapTool';

/**
 * **A map task's draft, held still while it saves.** A save sends the draft as it stood and, once
 * it lands, clears it. An edit made while it was out would be lost with it, or, if kept, saved a
 * second time as a new row. So while a save is out:
 *
 * - **`edit` does nothing**: the fields hold what was sent. The ref means a keystroke in the same
 *   tick as Save is refused too, before `saving` renders.
 * - **The map's engine stands down** (`heldEngine`): no click moves a mark the save won't keep.
 *   It comes back when the save settles, from the draft as it stands, which is what a refusal
 *   leaves.
 *
 * `setDraft` stays raw for the task's own transitions: start, discard, and the clear after a save.
 */
export function useTaskDraft<D>() {
  const [draft, setDraft] = useState<D | null>(null);
  const [saving, setSavingState] = useState(false);
  const savingNow = useRef(false);
  const setSaving = useCallback((on: boolean) => {
    savingNow.current = on;
    setSavingState(on);
  }, []);
  const edit = useCallback((f: (d: D) => D | null) => {
    if (savingNow.current) return;
    setDraft((d) => (d === null ? d : f(d)));
  }, []);
  return { draft, setDraft, edit, saving, setSaving };
}

/** The engine a task's claim holds: its own, or none while its save is out. */
export function heldEngine(saving: boolean, engine: MapToolEngine): MapToolEngine {
  return saving ? { kind: 'none' } : engine;
}
