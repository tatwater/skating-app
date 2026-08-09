import { allReferenceLinks, type ReferenceLinkBody, revealPlaceholder } from '@skating/core';
import { openBrowserAsync } from 'expo-web-browser';
import { Paragraph, Text, YStack } from 'tamagui';
import { Section } from './detailUi';

/**
 * The lake sheet's reference-link list (N6c Workstream B).
 *
 * **Every link opens in-app (D76).** `openBrowserAsync` is SFSafariViewController on iOS and Chrome
 * Custom Tabs on Android: the page opens *over* our app with a Done button, shares the system cookie
 * jar, and returns the skater exactly where they were. A skater checking Windy should not be ejected
 * into Safari and left to find their way back.
 *
 * **Why not a `WebView`.** Rendering a third-party page inside our own chrome sounds better and is
 * worse: it frames someone else's site inside our UI, which many providers' terms prohibit outright,
 * and it inherits their auth walls, cookie banners and consent flows with none of the system
 * browser's handling for them. An in-app browser is unambiguously *a browser* — the provider gets its
 * own URL bar, its own branding, its own terms, and there is no framing question to lose. A `WebView`
 * is only for content we are licensed to embed.
 *
 * Renders nothing when there is nothing to link to, matching the caption and the bathymetry credit.
 */
export function ReferenceLinks({
  body,
  reveal = false,
}: {
  body: ReferenceLinkBody | null | undefined;
  /** N6c-2's reveal flag — states the absence instead of hiding the section. */
  reveal?: boolean;
}) {
  const links = allReferenceLinks(body);
  if (links.length === 0 && !reveal) return null;

  return (
    <Section label="Elsewhere">
      {links.length === 0 ? (
        <Paragraph color="$foregroundMuted" fontSize={14} fontStyle="italic">
          {revealPlaceholder('links')}
        </Paragraph>
      ) : null}
      {links.map((link) => (
        <YStack key={link.id} gap="$1" paddingBottom="$2">
          <Paragraph
            color="$foreground"
            fontSize={14}
            textDecorationLine="underline"
            accessibilityRole="link"
            onPress={() => {
              // Fire and forget: a browser that fails to open is not something a skater can act on,
              // and an error toast over a link tap would be noise.
              void openBrowserAsync(link.url);
            }}
          >
            {link.label}
          </Paragraph>
          {link.note ? (
            <Text color="$foregroundMuted" fontSize={11}>
              {link.note}
            </Text>
          ) : null}
        </YStack>
      ))}
    </Section>
  );
}
