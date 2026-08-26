/**
 * `Input` / `TextArea` that survive a runtime theme change (D34 amendment).
 *
 * **The bug these exist to prevent.** Tamagui only re-renders a component on a theme change if that
 * component *tracked* at least one theme key while rendering — `useThemeState` reduces to
 * `keys.current.size ? true : props.needsUpdate?.()`. A color that comes from Tamagui's own
 * `defaultStyles` (`@tamagui/input`: `color: '$color'`, `backgroundColor: '$background'`) rather
 * than from a prop on the element doesn't register as a tracked key, so the instance quietly opts
 * out of theme updates for that property.
 *
 * Every other widget hides this, because Convex query results and local state re-render it
 * constantly and it re-resolves its colors on the way past. A `TextInput` whose `value` hasn't
 * changed just sits there — so text inputs were the only place the bug was visible, and it showed up
 * *per property*: the map search declared `backgroundColor` but not `color` and kept stale text on a
 * correct background; the Bio field declared `borderColor` but not `backgroundColor` and did the
 * exact opposite.
 *
 * So the three colors are passed as real props on the element, which is the arrangement already
 * proven to work — the props those two components *did* declare flipped correctly. Spread last, so
 * a call site can still override any of them.
 *
 * Import these instead of Tamagui's; `Input`/`TextArea` from `tamagui` are what reintroduce this.
 */

import type { ComponentProps } from 'react';
import { Input as TamaguiInput, TextArea as TamaguiTextArea } from 'tamagui';

type InputProps = ComponentProps<typeof TamaguiInput>;
type TextAreaProps = ComponentProps<typeof TamaguiTextArea>;

/**
 * `$color` and `$background` rather than `$foreground`/`$surface`: these are the Tamagui-standard
 * keys `tamagui.config.ts` maps our roles onto, and they're the same values the defaults would have
 * resolved to. The point is *where* they're declared, not what they resolve to.
 */
const THEMED_FIELD = {
  color: '$color',
  backgroundColor: '$background',
  borderColor: '$border',
} as const;

export function Input(props: InputProps) {
  return <TamaguiInput {...THEMED_FIELD} {...props} />;
}

export function TextArea(props: TextAreaProps) {
  return <TamaguiTextArea {...THEMED_FIELD} {...props} />;
}
