/**
 * Class lists the skater compositions share, all tokens. Both are **kit promotion candidates**
 * (B03 §1.0): they exist here only because no kit piece draws them yet.
 */

/**
 * The skater boards' primary: **solid ink** (`.btn.pri` — the inverted ground and ink, no corner
 * dots), where the kit's `primary` is the console's raised face with dots. Laid over a kit
 * `Button variant="primary"`, so size, type, focus and disabled stay the kit's.
 */
export const INK_PRIMARY =
  'bg-inv-bg text-inv-fg [--dot-opacity:0] lit:bg-inv-bg lit:text-inv-fg lit:[--dot-opacity:0] pressed:bg-inv-bg';

/**
 * A plate that isn't a kit Popover's (search's list is Base UI Autocomplete's own popup, anchored to
 * its input): the kit popover's exact skin — square, panel ground, `line2` edge, the plate shadow.
 */
export const PLATE =
  'rounded-container border border-solid border-line2 bg-panel shadow-plate font-(family-name:--family-sans) text-fg outline-none';
