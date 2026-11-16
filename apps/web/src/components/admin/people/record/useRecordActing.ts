import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { type ActOutcome, keepFocus } from '../person/useActing';
import { type RecordAction, type RecordWrite, type Target, targetKey } from './recordModel';

/**
 * **The sheet's side of a write, tied to its attempt.** Each press belongs to the item it was made
 * on: its busy button, its note, and where focus goes when it settles are that item's — so a write
 * that comes back after the operator moved on (another item opened, the sheet's lists changed under
 * it) never lights a button, writes a note, or moves focus on what they are looking at now.
 *
 * - **Busy keeps the control** (the kit `Button`'s `loading`): mounted and focusable, its width
 *   kept, until the server answers.
 * - **A refusal is a toast naming the person** (D268, said by the write path), wherever the
 *   moderator is when it comes; the caller learns only that it was refused — a dialog stays open
 *   over its reason. Nothing is said in the item's place but the sheet's own notes (`say`: the item
 *   changed under a dialog), which are not a server's answer.
 * - **Focus stays in the item** when the write settles and the item is still the one open: back to
 *   what held it, else the lever, else the pane — never to the page, and never after it moved on.
 */
export type RecordActing = {
  /** Which item's lever is on its way, and which lever. */
  busyOn: (target: Target) => RecordAction | null;
  /** The sheet's note standing on this item's lever, if any (never a server's words). */
  noteOn: (target: Target) => string | null;
  /** Whether the item's place is on screen and staying — the rule focus and notes ask. */
  stillHere: (target: Target) => boolean;
  /** Say the sheet's own note in the item's place (a dialog closed under a change). */
  say: (target: Target, text: string) => void;
  /**
   * The write, tied to its attempt. Resolves whether it landed, was refused (said in its toast), or
   * was not sent because this item's own write is still out (`waiting`).
   */
  run: (
    target: Target,
    write: RecordWrite,
    opts: { region: HTMLElement | null; inline: boolean },
  ) => Promise<ActOutcome>;
};

export function useRecordActing({
  current,
  present,
  onAct,
}: {
  /** The item open now. */
  current: Target | null;
  /**
   * Whether the item's place is on screen and staying: the sheet open (not sliding closed) and its
   * pane drawn (not the narrow layout's list). `false` from the moment leaving starts.
   */
  present: boolean;
  /** The write; resolves whether it landed (a refusal is said in its toast). */
  onAct: (target: Target, write: RecordWrite) => Promise<boolean>;
}): RecordActing {
  const [busy, setBusy] = useState<ReadonlyMap<string, RecordAction>>(new Map());
  const [note, setNote] = useState<{ key: string; text: string } | null>(null);
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
   * **"Is the item this belongs to still the one open"** — asked before a note is set or focus is
   * moved (never before a refusal is said: that is always a toast). The sheet mounted, its item's
   * place on screen and staying, and that item the one open. False from the moment leaving starts.
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
  // A note belongs to the item it was said on: moving on clears it.
  useEffect(() => {
    setNote((n) => (n !== null && n.key !== currentKey ? null : n));
  }, [currentKey]);

  const run = useCallback<RecordActing['run']>(
    async (target, write, { region, inline }) => {
      const key = targetKey(target);
      // A second press while its own write is out is not a second write — and not a landing.
      if (running.current.has(key)) return 'waiting';
      running.current.add(key);
      const action: RecordAction = write.kind;
      const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setBusy((b) => new Map(b).set(key, action));
      setNote((n) => (n?.key === key ? null : n));
      let landed: boolean;
      try {
        landed = await onAct(target, write);
      } catch {
        // The write path says every refusal itself; a throw past it changed nothing.
        landed = false;
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
      // Focus goes back into the item — unless a dialog was refused, which stays open and keeps
      // its own focus.
      if (stillHere(key) && (landed || inline)) {
        requestAnimationFrame(() => {
          if (stillHere(key)) keepFocus(region, before, 'record-lever');
        });
      }
      return landed ? 'landed' : 'refused';
    },
    [onAct, stillHere],
  );

  return {
    // Nothing is said into a place that is leaving.
    say: useCallback(
      (t: Target, text: string) => {
        const key = targetKey(t);
        if (stillHere(key)) setNote({ key, text });
      },
      [stillHere],
    ),
    stillHere: (t) => stillHere(targetKey(t)),
    busyOn: (t) => busy.get(targetKey(t)) ?? null,
    noteOn: (t) => (note !== null && note.key === targetKey(t) ? note.text : null),
    run,
  };
}
