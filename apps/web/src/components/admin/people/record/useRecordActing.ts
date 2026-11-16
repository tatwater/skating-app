import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { keepFocus } from '../person/useActing';
import { type RecordAction, type RecordWrite, type Target, targetKey } from './recordModel';
import { RECORD_WORDS as W } from './recordWords';

/**
 * **The sheet's side of a write, tied to its attempt.** Each press belongs to the item it was made
 * on: its busy button, its refusal, and where focus goes when it settles are that item's — so a
 * write that comes back after the operator moved on (another item opened, the sheet's lists changed
 * under it) never lights a button, writes a refusal, or moves focus on what they are looking at now.
 *
 * - **Busy keeps the control** (the kit `Button`'s `loading`): mounted and focusable, its width
 *   kept, until the server answers.
 * - **A refusal stands in its place**, in the server's own words — when the write came from the
 *   foot (`inline`). A dialog keeps its own refusal over the kept reason.
 * - **A late refusal** — the item no longer open — is said once, out of the way (`onLateRefusal`,
 *   the console's toast), never on another item.
 * - **Focus stays in the item** when the write settles and the item is still the one open: back to
 *   what held it, else the lever, else the pane — never to the page, and never after it moved on.
 */
export type RecordActing = {
  /** Which item's lever is on its way, and which lever. */
  busyOn: (target: Target) => RecordAction | null;
  /** The refusal standing on this item's lever, if any. */
  refusalOn: (target: Target) => string | null;
  run: (
    target: Target,
    write: RecordWrite,
    opts: { region: HTMLElement | null; inline: boolean },
  ) => Promise<string | null>;
};

export function useRecordActing({
  current,
  onAct,
  onLateRefusal,
}: {
  /** The item open now. */
  current: Target | null;
  /** The write; resolves to the server's refusal, or `null` once it landed. */
  onAct: (target: Target, write: RecordWrite) => Promise<string | null>;
  /** A refusal for an item no longer open. */
  onLateRefusal: (text: string) => void;
}): RecordActing {
  const [busy, setBusy] = useState<ReadonlyMap<string, RecordAction>>(new Map());
  const [refusal, setRefusal] = useState<{ key: string; text: string } | null>(null);
  const currentKey = current === null ? null : targetKey(current);
  const open = useRef(currentKey);
  const mounted = useRef(true);
  const running = useRef(new Set<string>());

  useLayoutEffect(() => {
    open.current = currentKey;
  }, [currentKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A refusal belongs to the item it was said on: moving on clears it.
  useEffect(() => {
    setRefusal((r) => (r !== null && r.key !== currentKey ? null : r));
  }, [currentKey]);

  const run = useCallback<RecordActing['run']>(
    async (target, write, { region, inline }) => {
      const key = targetKey(target);
      // A second press while its own write is out is not a second write — and not a landing.
      if (running.current.has(key)) return W.anotherOnItsWay;
      running.current.add(key);
      const action: RecordAction = write.kind;
      const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setBusy((b) => new Map(b).set(key, action));
      setRefusal((r) => (r?.key === key ? null : r));
      let refused: string | null;
      try {
        refused = await onAct(target, write);
      } catch {
        refused = W.somethingWrong;
      }
      running.current.delete(key);
      if (!mounted.current) {
        if (refused !== null) onLateRefusal(refused);
        return refused;
      }
      setBusy((b) => {
        const next = new Map(b);
        next.delete(key);
        return next;
      });
      // Moved on: nothing here may touch the item open now.
      if (open.current !== key) {
        if (refused !== null) onLateRefusal(refused);
        return refused;
      }
      if (refused !== null && inline) setRefusal({ key, text: refused });
      if (refused === null || inline) {
        requestAnimationFrame(() => {
          if (open.current === key) keepFocus(region, before, 'record-lever');
        });
      }
      return refused;
    },
    [onAct, onLateRefusal],
  );

  return {
    busyOn: (t) => busy.get(targetKey(t)) ?? null,
    refusalOn: (t) => (refusal !== null && refusal.key === targetKey(t) ? refusal.text : null),
    run,
  };
}
