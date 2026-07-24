import { api } from '@skating/convex/api';
import { useMutation } from 'convex/react';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Paragraph, Text, TextArea, XStack, YStack } from 'tamagui';

/**
 * Contact-support / report-a-bug (D35) — the mobile half of the one operator-adjacent surface that
 * ships on both platforms (a *submission* path, not the operator inbox). Mirrors the web
 * `ContactSupport`: pick a topic, write a message, send. `support.create` doesn't gate on account
 * status, so a suspended/banned user can still file an **appeal** (`category: account`). Captures
 * platform + app version as context the server stores.
 */
const CATEGORIES = [
  { value: 'bug', label: 'Bug' },
  { value: 'account', label: 'Account / appeal' },
  { value: 'safety', label: 'Safety' },
  { value: 'other', label: 'Other' },
] as const;

const PLATFORM = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
const APP_VERSION = Constants.expoConfig?.version ?? '0.0.1';

export default function SupportScreen() {
  const create = useMutation(api.support.create);
  const router = useRouter();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('bug');
  const [body, setBody] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function onSubmit() {
    if (!body.trim()) return;
    setState('sending');
    try {
      await create({
        category,
        body: body.trim(),
        context: { platform: PLATFORM, appVersion: APP_VERSION },
      });
      setBody('');
      setState('sent');
    } catch {
      setState('error');
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
      <ScrollView>
        <YStack flex={1} gap="$3" padding="$4" backgroundColor="$background">
          {state === 'sent' ? (
            <YStack gap="$3">
              <Paragraph color="$foreground">
                Thanks — we got it. We'll follow up if we need more.
              </Paragraph>
              <Button onPress={() => setState('idle')}>Send another</Button>
              <Button chromeless onPress={() => router.back()}>
                Done
              </Button>
            </YStack>
          ) : (
            <>
              <Text
                color="$foregroundMuted"
                fontSize={11}
                letterSpacing={1.5}
                textTransform="uppercase"
              >
                Topic
              </Text>
              <XStack gap="$2" flexWrap="wrap">
                {CATEGORIES.map((c) => (
                  <Button
                    key={c.value}
                    size="$2"
                    backgroundColor={category === c.value ? '$primary' : undefined}
                    color={category === c.value ? '$primaryForeground' : '$foreground'}
                    onPress={() => setCategory(c.value)}
                  >
                    {c.label}
                  </Button>
                ))}
              </XStack>

              <Text
                color="$foregroundMuted"
                fontSize={11}
                letterSpacing={1.5}
                textTransform="uppercase"
              >
                Message
              </Text>
              <TextArea
                value={body}
                onChangeText={setBody}
                placeholder="What's going on?"
                borderColor="$border"
                minHeight={120}
              />

              {state === 'error' ? (
                <Paragraph color="$danger">Couldn't send that. Please try again.</Paragraph>
              ) : null}

              <Button
                backgroundColor="$primary"
                color="$primaryForeground"
                disabled={!body.trim() || state === 'sending'}
                onPress={onSubmit}
              >
                {state === 'sending' ? 'Sending…' : 'Send'}
              </Button>
            </>
          )}
        </YStack>
      </ScrollView>
    </SafeAreaView>
  );
}
