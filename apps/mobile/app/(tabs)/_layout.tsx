import { Tabs } from 'expo-router';
import { useTheme } from 'tamagui';

/**
 * The five co-primary tabs from the app structure (00-vision / D28):
 * Map (default) · Newsfeed · ＋ Report · Bounties · You.
 * Icons come in the UI deep-dive PR; barebones ships text labels only.
 */
export default function TabsLayout() {
  const theme = useTheme();
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
      }}
    >
      <Tabs.Screen name="(map)" options={{ title: 'Map' }} />
      <Tabs.Screen name="feed" options={{ title: 'Newsfeed' }} />
      <Tabs.Screen name="report" options={{ title: '＋ Report' }} />
      <Tabs.Screen name="bounties" options={{ title: 'Bounties' }} />
      <Tabs.Screen name="you" options={{ title: 'You' }} />
    </Tabs>
  );
}
