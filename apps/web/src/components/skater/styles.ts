import { POPOVER_PLATE } from '../kit/popover';

/**
 * Class lists the skater compositions share, all tokens. `INK_PRIMARY` is the skater surface's own
 * primary; `PLATE` is the kit popover's skin, named here for the compositions that lay it on.
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
 * its input): the kit popover's own skin, so the two can't drift apart.
 */
export const PLATE = POPOVER_PLATE;
