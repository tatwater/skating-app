import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faLocationDot, faMagnifyingGlass } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import { useAction } from 'convex/react';
import { openBrowserAsync } from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { Text, useTheme, XStack, YStack } from 'tamagui';
import {
  type AddressLookup,
  type AddressLookupController,
  type AddressSuggestion,
  attributionSpans,
  createAddressLookup,
  lookupAttribution,
  shownSuggestions,
  splitAddress,
} from '../../lib/addressLookup';
import { ONBOARDING_COPY_MOBILE } from '../../lib/onboardingCopyMobile';
import { Input } from '../ThemedInputs';
import { FieldHint, FieldLabel, FieldProblem } from './OnboardingFrame';

/**
 * The Home step's typed address (boards 11.10–11.11): the phone's first typed-address field, over
 * `geocode.suggest`, with the provider's credit under its suggestions wherever they show (the
 * web Settings field's rule). The debounce, the three-character floor and the session latches are
 * `src/lib/addressLookup.ts`'s. What's typed is someone's address: it goes to our server and the
 * provider, nowhere else.
 */
export function AddressField({
  label,
  hint,
  value,
  onValueChange,
  onPick,
}: {
  label: string;
  hint: string;
  value: string;
  onValueChange: (value: string) => void;
  onPick: (suggestion: AddressSuggestion) => void;
}) {
  const theme = useTheme();
  const suggest = useAction(api.geocode.suggest);
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;
  const [lookup, setLookup] = useState<AddressLookup>({ state: 'unknown' });
  const [closed, setClosed] = useState(false);

  // Made in the effect (not a memo) so a remount always gets a live one.
  const controller = useRef<AddressLookupController | null>(null);
  useEffect(() => {
    const made = createAddressLookup({
      suggest: (args) => suggestRef.current(args),
      onChange: setLookup,
    });
    controller.current = made;
    setLookup(made.current());
    return () => {
      made.dispose();
      controller.current = null;
    };
  }, []);

  const suggestions = shownSuggestions(lookup);
  const open = !closed && suggestions.length > 0;
  const attribution = lookupAttribution(lookup);
  const typed = value.trim().toLowerCase();
  const out = lookup.state === 'off' || lookup.state === 'quota';

  return (
    <YStack gap="1">
      <FieldLabel>{label}</FieldLabel>
      <XStack alignItems="center" gap="2" borderBottomWidth={1} borderColor="border">
        <FontAwesomeIcon icon={faMagnifyingGlass} size={15} color={theme.foregroundMuted?.val} />
        <Input
          flex={1}
          borderWidth={0}
          borderRadius={0}
          backgroundColor="transparent"
          paddingHorizontal={0}
          value={value}
          readOnly={out}
          placeholder={ONBOARDING_COPY_MOBILE.home.addressPlaceholder}
          accessibilityLabel={label}
          autoCorrect={false}
          autoComplete="street-address"
          textContentType="fullStreetAddress"
          onChangeText={(text) => {
            setClosed(false);
            onValueChange(text);
            controller.current?.setText(text);
          }}
        />
      </XStack>
      {open ? (
        <YStack borderWidth={1} borderColor="border" backgroundColor="surface" marginTop="1">
          {suggestions.map((s) => {
            const { street, rest } = splitAddress(s.label);
            const bold = typed.length > 0 && street.toLowerCase().startsWith(typed);
            return (
              <XStack
                key={`${s.label}-${s.lat}-${s.lng}`}
                minHeight={48}
                paddingHorizontal="3"
                gap="3"
                alignItems="center"
                backgroundColor="press:surfaceMuted"
                accessibilityRole="button"
                accessibilityLabel={s.label}
                onPress={() => {
                  setClosed(true);
                  onPick(s);
                }}
              >
                <FontAwesomeIcon
                  icon={faLocationDot}
                  size={13}
                  color={theme.foregroundMuted?.val}
                />
                <Text flex={1} color="foreground" fontSize={15} numberOfLines={1}>
                  {bold ? (
                    <>
                      <Text fontWeight="700" color="foreground">
                        {street.slice(0, typed.length)}
                      </Text>
                      {street.slice(typed.length)}
                    </>
                  ) : (
                    street
                  )}
                  {rest ? (
                    <Text color="foregroundMuted" fontSize={12}>
                      {`  ${rest}`}
                    </Text>
                  ) : null}
                </Text>
              </XStack>
            );
          })}
          {attribution ? <Attribution text={attribution} /> : null}
        </YStack>
      ) : null}
      {out ? (
        <FieldProblem>{ONBOARDING_COPY_MOBILE.home.suggestionsOff}</FieldProblem>
      ) : lookup.state === 'error' ? (
        <FieldProblem>{ONBOARDING_COPY_MOBILE.home.suggestionsFailed}</FieldProblem>
      ) : (
        <FieldHint>{hint}</FieldHint>
      )}
    </YStack>
  );
}

/** The provider's credit, its two known names linked to their own pages. */
function Attribution({ text }: { text: string }) {
  return (
    <Text
      color="foregroundMuted"
      fontSize={11}
      paddingHorizontal="3"
      paddingVertical="2"
      borderTopWidth={1}
      borderColor="border"
    >
      {attributionSpans(text).map((span, i) =>
        span.href ? (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: spans of one fixed string
            key={i}
            color="foregroundMuted"
            textDecorationLine="underline"
            accessibilityRole="link"
            onPress={() => void openBrowserAsync(span.href as string)}
          >
            {span.text}
          </Text>
        ) : (
          span.text
        ),
      )}
    </Text>
  );
}
