import Constants from 'expo-constants'
import { openBrowserAsync } from 'expo-web-browser'
import { ScrollView } from 'react-native'
import { Anchor, H2, Paragraph, YStack } from 'tamagui'
import { DOC_URLS } from '../src/lib/links'

/**
 * About + license disclosure (D43). The app is AGPL-3.0 with a GPLv3 §7 App
 * Store / Play distribution exception; both are referenced here per the Phase 0
 * license-hygiene requirement. Final legal wording remains Q10.
 */
export default function AboutScreen() {
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <YStack gap="$3" backgroundColor="$background">
        <H2 color="$foreground">Skating</H2>
        <Paragraph color="$foregroundMuted">
          Version {Constants.expoConfig?.version ?? '0.0.1'}. A map-first, peer ice-reporting app
          for Nordic (wild) ice skating. Reports are named peers' observations at a specific time
          and place — never a guarantee that ice is safe. You alone decide whether to step on the
          ice.
        </Paragraph>

        <H2 color="$foreground">License</H2>
        <Paragraph color="$foregroundMuted">
          Licensed under AGPL-3.0, with a GPLv3 §7 additional permission (an App Store / Google Play
          distribution exception) so the app can ship on both stores.
        </Paragraph>
        <Anchor color="$primary" onPress={() => openBrowserAsync(DOC_URLS.license)}>
          AGPL-3.0 license
        </Anchor>
        <Anchor color="$primary" onPress={() => openBrowserAsync(DOC_URLS.licenseExceptions)}>
          App Store / Play exception
        </Anchor>
        <Anchor color="$primary" onPress={() => openBrowserAsync(DOC_URLS.privacy)}>
          Privacy notice
        </Anchor>
        <Anchor color="$primary" onPress={() => openBrowserAsync(DOC_URLS.terms)}>
          Terms (interim)
        </Anchor>
      </YStack>
    </ScrollView>
  )
}
