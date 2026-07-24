import { api } from '@skating/convex/api';
import {
  STRAVA_ATTRIBUTION,
  STRAVA_BRAND_COLOR,
  STRAVA_CONNECT_EXPLAINER,
  STRAVA_CONNECT_LABEL,
  STRAVA_CONNECTED_LABEL,
  STRAVA_DISCONNECT_LABEL,
  STRAVA_UNCONFIGURED_NOTE,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui';

/**
 * The Strava connect control (Phase 8 / L7 brand kit).
 *
 * The flow is: mint a state nonce server-side → open Strava's consent page in the **system browser**
 * (not a webview — OAuth in an embedded webview is both a phishing surface and increasingly refused
 * by providers) → Strava redirects to our Convex `.site` callback → the callback burns the nonce,
 * stores the tokens, and bounces back into the app via a deep link.
 *
 * The copy states what the integration does and doesn't do before the consent screen appears: we push
 * your own skates to your own account, and we never read anything back. That's the legal shape of the
 * integration (L7), not a reassurance we invented.
 */
export function StravaConnect() {
  const status = useQuery(api.strava.connectionStatus, {});
  const beginConnect = useMutation(api.strava.beginConnect);
  const disconnect = useMutation(api.strava.disconnect);
  const [busy, setBusy] = useState(false);

  if (status === undefined) return null;

  if (!status.configured) {
    return (
      <Paragraph color="$foregroundMuted" fontSize={12}>
        {STRAVA_UNCONFIGURED_NOTE}
      </Paragraph>
    );
  }

  async function connect() {
    setBusy(true);
    try {
      const { authorizeUrl } = await beginConnect({
        // Where the callback sends the browser once it's done — straight back into the app.
        redirectTo: Linking.createURL('/settings'),
      });
      await WebBrowser.openAuthSessionAsync(authorizeUrl, Linking.createURL('/settings'));
    } finally {
      setBusy(false);
    }
  }

  if (status.connected) {
    return (
      <YStack gap="$2">
        <XStack justifyContent="space-between" alignItems="center">
          <Text color="$foreground">{STRAVA_CONNECTED_LABEL}</Text>
          <Button size="$2" chromeless disabled={busy} onPress={() => disconnect()}>
            {STRAVA_DISCONNECT_LABEL}
          </Button>
        </XStack>
        <Paragraph color="$foregroundMuted" fontSize={11}>
          {STRAVA_ATTRIBUTION}
        </Paragraph>
      </YStack>
    );
  }

  return (
    <YStack gap="$2">
      <Paragraph color="$foregroundMuted" fontSize={12}>
        {STRAVA_CONNECT_EXPLAINER}
      </Paragraph>
      <Button
        size="$4"
        backgroundColor={STRAVA_BRAND_COLOR}
        color="#fff"
        disabled={busy}
        onPress={connect}
        accessibilityLabel={STRAVA_CONNECT_LABEL}
      >
        {busy ? 'Opening Strava…' : STRAVA_CONNECT_LABEL}
      </Button>
      <Paragraph color="$foregroundMuted" fontSize={11}>
        {STRAVA_ATTRIBUTION}
      </Paragraph>
    </YStack>
  );
}
