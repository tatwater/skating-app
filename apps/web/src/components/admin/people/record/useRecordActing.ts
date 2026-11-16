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
 * - **A late refusal** — the item no longer open, or its place leaving (the sheet sliding closed,
 *   the narrow layout's list) — is said once, out of the way (`onLateRefusal`, the console's
 *   toast), never on another item.
 * - **Focus stays in the item** when the write settles and the item is still the one open: back to
 *   what held it, else the lever, else the pane — never to the page, and never after it moved on.
 */
export type RecordActing = {
  /** Which item's lever is on its way, and which lever. */
  busyOn: (target: Target) => RecordAction | null;
  /** The refusal standing on this item's lever, if any. */
  refusalOn: (target: Target) => string | null;
  /** Whether the item's place is on screen and staying — the one rule every answer asks. */
  stillHere: (target: Target) => boolean;
  /** Say something in the item's place (a dialog closed under a change), as a refusal stands. */
  say: (target: Target, text: string) => void;
  /**
   * The write, tied to its attempt. Resolves to the server's refusal while the item's place is
   * still there; once leaving has begun, to `null` — a refusal has gone to `onLateRefusal`, so to
   * the caller (a dialog, the chooser) the answer is settled either way, never "landed" for sure.
   */
  run: (
    target: Target,
    write: RecordWrite,
    opts: { region: HTMLElement | null; inline: boolean },
  ) => Promise<string | null>;
};

export function useRecordActing({
  current,
  present,
  onAct,
  onLateRefusal,
}: {
  /** The item open now. */
  current: Target | null;
  /**
   * Whether the item's place is on screen and staying: the sheet open (not sliding closed) and its
   * pane drawn (not the narrow layout's list). `false` from the moment leaving starts.
   */
  present: boolean;
  /** The write; resolves to the server's refusal, or `null` once it landed. */
  onAct: (target: Target, write: RecordWrite) => Promise<string | null>;
  /** A refusal for an item no longer open, or whose place is leaving. */
  onLateRefusal: (text: string) => void;
}): RecordActing {
  const [busy, setBusy] = useState<ReadonlyMap<string, RecordAction>>(new Map());
  const [refusal, setRefusal] = useState<{ key: string; text: string } | null>(null);
  const currentKey = current === null ? null : targetKey(current);
  const open = useRef(currentKey);
  const shown = useRef(present);
  const mounted = useRef(true);
  const running = useRef(new Set<string>());

  useLayoutEffect(() => {
    open.current = currentKey;
    shown.current = present;
  }, [currentKey, present]);
  /**
   * **The one rule for "is the place this result belongs still there"** — every write's answer asks
   * it, and so does the focus it would move: the sheet mounted, its item's place on screen and
   * staying, and that item the one open. False from the moment leaving starts (Close, Esc, the
   * backdrop; another item, another tab; the narrow layout's way back; the page going), not when
   * the unmount finishes: an answer that lands during the slide out is a late one.
   */
  const stillHere = useCallback(
    (key: string) => mounted.current && shown.current && open.current === key,
    [],
  );
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
      // The press is over wherever it was made: no spinner left behind for a later visit.
      if (mounted.current) {
        setBusy((b) => {
          const next = new Map(b);
          next.delete(key);
          return next;
        });
      }
      // Left (or leaving): a refusal is said once, out of the way, and nothing is written into
      // what is on its way out — to the caller (a dialog, the chooser) the answer is settled.
      if (!stillHere(key)) {
        if (refused !== null) onLateRefusal(refused);
        return null;
      }
      if (refused !== null && inline) setRefusal({ key, text: refused });
      if (refused === null || inline) {
        requestAnimationFrame(() => {
          if (stillHere(key)) keepFocus(region, before, 'record-lever');
        });
      }
      return refused;
    },
    [onAct, onLateRefusal, stillHere],
  );

  return {
    // The same rule as every answer: nothing is said into a place that is leaving.
    say: useCallback(
      (t: Target, text: string) => {
        const key = targetKey(t);
        if (stillHere(key)) setRefusal({ key, text });
      },
      [stillHere],
    ),
    stillHere: (t) => stillHere(targetKey(t)),
    busyOn: (t) => busy.get(targetKey(t)) ?? null,
    refusalOn: (t) => (refusal !== null && refusal.key === targetKey(t) ? refusal.text : null),
    run,
  };
}
