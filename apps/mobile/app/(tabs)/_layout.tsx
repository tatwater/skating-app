import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import {
  faBinoculars,
  faCirclePlus,
  faMap,
  faNewspaper,
  faUser,
} from '@fortawesome/sharp-duotone-solid-svg-icons';
import { api } from '@skating/convex/api';
import { deviceTimeZone, timezoneToSync } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { type ColorValue, View } from 'react-native';
import { useTheme } from 'tamagui';

/**
 * How much of the icon the duotone secondary layer keeps. FontAwesome's own default is 0.4, which
 * is tuned for a filled glyph on a light page; on the tab bar's `$surface` at 24px it muddies the
 * *inactive* icons, where the primary is already the muted foreground. 0.3 keeps the two layers
 * legible as two layers without the secondary competing with the primary at a glance.
 */
const DUOTONE_SECONDARY_OPACITY = 0.3;

/**
 * React Navigation hands `tabBarIcon` a `ColorValue`, which also admits the opaque platform-color
 * objects (`PlatformColor`, `DynamicColorIOS`) that an SVG `fill` cannot take. Ours are always plain
 * hex off the Tamagui theme, so narrow rather than cast — a non-string would silently fall back to
 * FontAwesome's default instead of crashing the tab bar.
 *
 * Both duotone layers take the *same* navigator-resolved color, separated only by opacity. Giving
 * the secondary a fixed accent instead would make the inactive tabs carry a color the focused one
 * doesn't, which reads as five half-selected tabs.
 */
function TabIcon({ icon, color, size }: { icon: IconDefinition; color: ColorValue; size: number }) {
  const tint = typeof color === 'string' ? color : undefined;
  return (
    <FontAwesomeIcon
      icon={icon}
      color={tint}
      secondaryColor={tint}
      secondaryOpacity={DUOTONE_SECONDARY_OPACITY}
      size={size}
    />
  );
}

/**
 * The five co-primary tabs from the app structure (00-vision / D28):
 * Map (default) · Latest · Report · Bounties · You.
 *
 * Icons are FontAwesome **Sharp Duotone**, rendered through `react-native-svg` — no icon font, so
 * nothing here needs a native rebuild beyond the SVG dep the app already carries. Duotone is the
 * tab bar's alone: two layers give focus a second signal besides color, which the rest of the app
 * (Sharp Light) has no use for. Bounties gets binoculars rather than a trophy or a coin: a bounty
 * is a request to *go look* at a lake, and neither prize money nor competition exists in the
 * model (D10/D17).
 *
 * The tint comes from the navigator, not from us — `tabBarIcon` receives the already-resolved
 * active/inactive `color`, so the icon and its label can never disagree about focus state.
 */
export default function TabsLayout() {
  const theme = useTheme();
  // The unread signal (N8/A3): a dot on the You icon, visible from every screen with the tab bar,
  // so the badge costs no tab. `unreadCount` is one capped indexed read, so subscribing to it from
  // the tab layout — effectively app-wide — is cheap by construction.
  const unread = useQuery(api.notifications.unreadCount, {}) ?? 0;

  // The 8pm digest's zone (N8/C): the device's, refreshed on app open, written only when it differs.
  // The tab layout mounts once per signed-in session, which makes it "app open".
  const profile = useQuery(api.profiles.current, {});
  const setTimezone = useMutation(api.profiles.setTimezone);
  const hasProfile = !!profile;
  const storedZone = profile?.timezone;
  useEffect(() => {
    if (!hasProfile) return;
    const timezone = timezoneToSync(storedZone, deviceTimeZone());
    if (timezone !== null) void setTimezone({ timezone }).catch(() => {});
  }, [hasProfile, storedZone, setTimezone]);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.primary?.val,
        tabBarInactiveTintColor: theme.foregroundMuted?.val,
        tabBarStyle: {
          backgroundColor: theme.surface?.val,
          borderTopColor: theme.border?.val,
        },
        /**
         * The surface every tab screen is drawn on. Without it React Navigation paints its own
         * default — a light one — and only the parts of a screen that actually have content get
         * themed: a screen's `YStack backgroundColor="$background"` is as tall as its children, so
         * anything shorter than the viewport showed a light page under dark text. The map hid it by
         * being full-bleed, which is why this survived the first pass.
         *
         * Set here as well as on the root `Stack` in `app/_layout.tsx`: they're separate navigators
         * and each paints its own scene.
         */
        sceneStyle: { backgroundColor: theme.background?.val },
      }}
    >
      <Tabs.Screen
        name="(map)"
        options={{
          title: 'Map',
          tabBarIcon: ({ color, size }) => <TabIcon icon={faMap} color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Latest',
          tabBarIcon: ({ color, size }) => <TabIcon icon={faNewspaper} color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="report"
        options={{
          title: 'Report',
          tabBarIcon: ({ color, size }) => (
            <TabIcon icon={faCirclePlus} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="bounties"
        options={{
          title: 'Bounties',
          tabBarIcon: ({ color, size }) => (
            <TabIcon icon={faBinoculars} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="you"
        options={{
          title: 'You',
          // The dot is decorative; the count rides on the tab's own label, which is what a screen
          // reader actually announces (a nested labelled View inside the icon is not read).
          tabBarAccessibilityLabel: unread > 0 ? `You, ${unread} unread notifications` : 'You',
          tabBarIcon: ({ color, size }) => (
            <View>
              <TabIcon icon={faUser} color={color} size={size} />
              {unread > 0 ? (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -4,
                    width: 9,
                    height: 9,
                    borderRadius: 5,
                    backgroundColor: theme.primary?.val,
                    borderWidth: 1.5,
                    borderColor: theme.surface?.val,
                  }}
                />
              ) : null}
            </View>
          ),
        }}
      />
    </Tabs>
  );
}
