import type { Where } from '@skating/core';
import { createContext, type ReactNode, use, useMemo, useState } from 'react';

/**
 * The console's **mode** (A10-6 / D206): the transient state in which the instrument — the lake in
 * the center column — is an input for a question open in the inspector. Two questions can open one:
 *
 * - **where** — a chip's `where` (D193). The compass ring appears around the lake, a click on an
 *   arc or the water names a sector, a point; everything that is not the lake and the question dims.
 * - **put-in** — the Access section's launch (D198). The launches light up; a click on one chooses
 *   it, a click on the shore is *somewhere else*.
 *
 * A mode is entered by opening the question and left by a click — the question's *Done* or the
 * instrument's — never by Escape, which is the sheet's (one Esc per screen). It is never entered by a
 * chip click alone (a five-chip reporter would be pulled into it five times), and it is never
 * permanent: the ring is a cursor, not a control. The mode holds the callbacks the instrument
 * needs, so the question block and the map agree on what a click means — and `onExit`, so that
 * leaving from the instrument closes the question that armed it rather than leaving a dead block.
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
  /** The question's own close, run when the mode is left from outside it (the instrument's Done). */
  onExit?: () => void;
};

interface ConsoleModeValue {
  mode: ConsoleMode | null;
  /**
   * Whether there is an instrument to take a mode. A phone's sheet (row 9) draws the lake as a
   * summary strip, with no map that can take a click, so a question that would arm a mode offers
   * only what works without one — never an affordance that arms a mode nothing answers.
   */
  instrument: boolean;
  setMode: (mode: ConsoleMode | null) => void;
  /** Leave the mode from outside the question — and close the question that opened it. */
  exit: () => void;
}

const Ctx = createContext<ConsoleModeValue | null>(null);

export function ConsoleModeProvider({
  children,
  instrument = true,
}: {
  children: ReactNode;
  /** False on a phone: no instrument, so no mode is ever live. */
  instrument?: boolean;
}) {
  const [stored, setMode] = useState<ConsoleMode | null>(null);
  // A mode armed on a wide window and left when it narrows to a phone goes with the instrument.
  const mode = instrument ? stored : null;
  // A mode is left by a click — the question's Done, or the instrument's — never by Escape: Esc is
  // the sheet's, one per screen (B03 Review 3). Leaving from the instrument closes the question
  // that opened it too, so the block and the instrument always agree.
  const value = useMemo(
    () => ({
      mode,
      instrument,
      setMode,
      exit: () => {
        mode?.onExit?.();
        setMode(null);
      },
    }),
    [mode, instrument],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

/**
 * The mode and its setter. Outside the console (a test, a panel reused elsewhere) there is no mode;
 * the panels keep their console shape there.
 */
export function useConsoleMode(): ConsoleModeValue {
  return use(Ctx) ?? NO_MODE;
}

const NO_MODE: ConsoleModeValue = {
  mode: null,
  instrument: true,
  setMode: () => {},
  exit: () => {},
};
