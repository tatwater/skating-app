import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faLayerGroup, faXmark } from '@fortawesome/sharp-light-svg-icons';
import type { ReactNode } from 'react';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

/**
 * The imagery toggle and the freeze-up scrubber, as one box (N6e / D146).
 *
 * > **Founder, 2026-08-25:** *"tapping/clicking 'Show imagery' [should] make the button grow/
 * > transition into the timeline scrubber container, with an X in the upper right to turn off
 * > imagery and collapse the timeline back into the button."*
 *
 * The toggle used to live in the top-right corner and the scrubber at the bottom, which made them
 * look like two features. They are one: the timeline is what "imagery on" *means*. So the button sits
 * where the timeline sits, and pressing it grows that same box into the timeline. The mirror of web's
 * `ImageryControl`, and the arguments are written up there.
 *
 * ## The sheet, which mobile has and web does not
 *
 * This box lives in the strip the drawer leaves above itself, so a sheet pulled up to read about a
 * lake would bury it. Two rules, both the founder's:
 *
 * 1. **The box collapses but never disappears.** The timeline needs the map's bottom third; the
 *    button needs 40 px. So when the sheet rises the scrubber folds away and the button rides just
 *    above the sheet's top edge — the toggle stays reachable, which is what the old top-right
 *    placement bought and what a naïve move to the bottom would have thrown away.
 * 2. **Pressing it brings the sheet down** to its lowest open position — the one that leaves room for
 *    the timeline. A control that opened a panel underneath the thing covering it would be asking the
 *    skater to guess what it just did.
 *
 * ⚠ Rule 1 means the collapsed button has *two* meanings: with imagery off it turns imagery on, and
 * with imagery on it means "bring the timeline back". It is labelled for whichever one it is, because
 * a button reading "Show imagery" over imagery already on the map is a lie about the screen.
 */
export function ImageryDock({
  visible,
  imageryOn,
  expanded,
  heading,
  seasonLabel,
  bottom,
  onPress,
  onClose,
  children,
}: {
  visible: boolean;
  imageryOn: boolean;
  /** Imagery is on **and** the sheet is out of the way — the only state the timeline fits in. */
  expanded: boolean;
  /**
   * *"Freeze-up timeline"*, or `null` where there is no timeline to head — an archive that was never
   * configured, where the dock is a bare toggle and a heading would promise a control that is not
   * coming. Hoisted out of the scrubber because the X shares this row and has to outlive it.
   */
  heading: string | null;
  /**
   * **What season is on this lake** — `winter 2025–26`. Web fills the same slot from the aerial when
   * no archived frame is up; mobile has no aerial layer at all (`useImageryReveal` needs a
   * `CanvasRenderingContext2D`), so here it is the archive's season or nothing.
   */
  seasonLabel: string | null;
  /** Distance above the screen's bottom edge: clear of the sheet wherever it settled. */
  bottom: number;
  /** Turn imagery on and/or ask the sheet down — see rule 2. */
  onPress: () => void;
  /** The X: off *and* collapsed, in one press. There is no third state. */
  onClose: () => void;
  /** The scrubber. Passed in, because the box it grows into is *its* container. */
  children?: ReactNode;
}) {
  const theme = useTheme();
  if (!visible) return null;

  return (
    <Animated.View
      // `box-none` so the map keeps the space this dock does not actually occupy — the wrapper spans
      // the full width to anchor a stretched panel, and a collapsed button must not eat taps beside it.
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 16, right: 16, bottom, zIndex: 20 }}
    >
      <Animated.View
        // The grow. `layout` animates the box between its two sizes, so the button becomes the panel
        // rather than being replaced by it. If a device ever drops the animation the geometry is still
        // correct — it just snaps, which is a worse transition and not a broken control.
        layout={LinearTransition.duration(220)}
        style={{ alignSelf: expanded ? 'stretch' : 'flex-start' }}
      >
        {expanded ? (
          <Animated.View entering={FadeIn.duration(160)}>
            <YStack
              padding="$3"
              borderRadius="$4"
              backgroundColor="$surface"
              borderColor="$border"
              borderWidth={1}
              gap="$2"
            >
              {/* One row: what this is, what season it is, and the way out. It was two — a bare X
                  above the scrubber's own title — which cost a row of a phone's map to say nothing.
                  The X is pulled into the padding so the glyph sits in the corner optically rather
                  than inset from it, and the row's height is the button's. */}
              <XStack
                alignItems="center"
                gap="$2"
                marginTop={-6}
                marginRight={-8}
                marginBottom={-4}
              >
                {heading ? (
                  <Text fontSize="$3" fontWeight="600" flexShrink={1}>
                    {heading}
                  </Text>
                ) : null}
                {seasonLabel ? (
                  <Text
                    color="$foregroundMuted"
                    fontSize="$1"
                    flex={1}
                    textAlign="right"
                    numberOfLines={1}
                  >
                    {seasonLabel}
                  </Text>
                ) : (
                  <XStack flex={1} />
                )}
                <Button
                  size="$2"
                  circular
                  chromeless
                  onPress={onClose}
                  accessibilityLabel="Turn off imagery"
                >
                  <FontAwesomeIcon icon={faXmark} size={16} color={theme.foreground?.val} />
                </Button>
              </XStack>
              {children}
            </YStack>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn.duration(160)}>
            <Button
              size="$3"
              backgroundColor={imageryOn ? '$primary' : '$surface'}
              borderColor="$border"
              borderWidth={1}
              onPress={onPress}
              accessibilityLabel={
                imageryOn ? 'Show the freeze-up timeline' : 'Show satellite imagery'
              }
            >
              <FontAwesomeIcon
                icon={faLayerGroup}
                size={14}
                color={(imageryOn ? theme.primaryForeground?.val : theme.foreground?.val) ?? '#fff'}
              />
              <Text color={imageryOn ? '$primaryForeground' : '$foreground'}>
                {imageryOn ? 'Timeline' : 'Show imagery'}
              </Text>
            </Button>
          </Animated.View>
        )}
      </Animated.View>
    </Animated.View>
  );
}
