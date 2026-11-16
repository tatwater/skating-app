import { createContext, useState } from 'react';

/**
 * **Where an answer is said: a drawn place** (D268, Greptile on #138). "Its place is still there"
 * is never "its component is mounted": a component can stop drawing the thing that shows a refusal
 * while it stays mounted — an early `return null` when a permission flips or a read fails, a dialog
 * closed by state, a pane kept mounted but hidden. A place registers itself by being rendered: its
 * element's ref (`usePlace`), asked when the answer arrives — drawn means in the document and not
 * inside anything hidden or inert.
 */
export type Place = { here: () => boolean };

/** Whether an element is drawn now: in the document, and not inside anything hidden or inert. */
export function drawn(el: Element | null | undefined): boolean {
  return el?.isConnected === true && el.closest('[hidden], [inert], .hidden') === null;
}

/** A place an element registers by its ref: here while that element is drawn. */
export function usePlace(): Place & { ref: (el: HTMLElement | null) => void } {
  const [place] = useState(() => {
    let el: HTMLElement | null = null;
    return {
      ref: (next: HTMLElement | null) => {
        el = next;
      },
      here: () => drawn(el),
    };
  });
  return place;
}

/** The place asking while a write starts (a reason dialog's, around its `onConfirm`). */
let asking: Place | null = null;

/**
 * Runs `start` with `place` as the place asking: a said write started inside it (synchronously)
 * belongs to that place. The reason dialogs wrap their confirm in it, so every write a dialog
 * starts says its refusal there while the dialog is drawn — no caller has to remember to.
 */
export function askFrom<T>(place: Place, start: () => T): T {
  const before = asking;
  asking = place;
  try {
    return start();
  } finally {
    asking = before;
  }
}

/** The place asking right now, if a dialog started this write. */
export function askingPlace(): Place | null {
  return asking;
}

/**
 * The place asking now, kept for the writes a confirm starts after an `await`: `askFrom` hands its
 * place only to the writes started synchronously, so a confirm that sends one write after another
 * (the water list's merges) runs each later one through what this returns.
 */
export function keepAsking(): <T>(start: () => T) => T {
  const place = asking;
  return (start) => (place === null ? start() : askFrom(place, start));
}

/**
 * A page that says every write's refusal in one place (the old editor's banner): its place, for
 * the said writes under it that hand none of their own (`useSaidMutation`).
 */
export const PagePlace = createContext<Place | null>(null);
