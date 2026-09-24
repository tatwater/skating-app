import type { Where } from '@skating/core';
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from 'react';

/**
 * The console's **mode** (A10-6 / D206): the transient state in which the instrument — the lake in
 * the center column — is an input for a question open in the inspector. Two questions can open one:
 *
 * - **where** — a chip's `where` (D193). The compass ring appears around the lake, a click on an
 *   arc or the water names a sector, a point; everything that is not the lake and the question dims.
 * - **put-in** — the Access section's launch (D198). The launches light up; a click on one chooses
 *   it, a click on the shore is *somewhere else*.
 *
 * A mode is entered by opening the question and left by *Done* or Escape. It is never entered by a
 * chip click alone (a five-chip reporter would be pulled into it five times), and it is never
 * permanent: the ring is a cursor, not a control. The mode holds the callbacks the instrument
 * needs, so the question block and the map agree on what a click means — and `onExit`, so that
 * Escape closes the question that armed it rather than leaving a dead block open.
 */
export type ConsoleMode = (
  | {
      kind: 'where';
      /** The chip the question is about, for the banner and the chip's own brackets. */
      label: string;
      where: Where | undefined;
      onChange: (where: Where | undefined) => void;
    }
  | {
      kind: 'putIn';
      onPickPin: (pinId: string, kind: 'putIn' | 'parking') => void;
      onPickShore: (coord: { lat: number; lng: number }) => void;
    }
  | {
      /** Place-mode (A10-7): a photo with no usable location; a click on the water is where it was taken. */
      kind: 'place';
      photoId: string;
      onPlace: (coord: { lat: number; lng: number }) => void;
    }
) & {
  /** The question's own close, run when the mode is left from outside it (Escape). */
  onExit?: () => void;
};

interface ConsoleModeValue {
  mode: ConsoleMode | null;
  setMode: (mode: ConsoleMode | null) => void;
}

const Ctx = createContext<ConsoleModeValue | null>(null);

export function ConsoleModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ConsoleMode | null>(null);
  // Escape leaves the mode from anywhere on the page — and closes the question that opened it, so
  // the block and the instrument agree; the question's own *Done* is the pointer's way.
  useEffect(() => {
    if (mode === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      mode.onExit?.();
      setMode(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);
  const value = useMemo(() => ({ mode, setMode }), [mode]);
  return <Ctx value={value}>{children}</Ctx>;
}

/** The mode and its setter. Outside the console (a test, a panel reused elsewhere) there is no mode. */
export function useConsoleMode(): ConsoleModeValue {
  return use(Ctx) ?? NO_MODE;
}

const NO_MODE: ConsoleModeValue = { mode: null, setMode: () => {} };
