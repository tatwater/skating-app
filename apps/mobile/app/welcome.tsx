import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faLocationCrosshairs } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import { BIO_MAX_LENGTH, ONBOARDING_COPY, TOWN_LABEL_MAX_LENGTH } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import * as Location from 'expo-location';
import { type ReactNode, useState } from 'react';
import { Button, Paragraph, Separator, Switch, Text, useTheme, XStack, YStack } from 'tamagui';
import { AddressField } from '../src/components/onboarding/AddressField';
import {
  FieldHint,
  FieldLabel,
  FieldProblem,
  OnboardingFrame,
  PrimaryButton,
  SecondaryButton,
  StepHeader,
} from '../src/components/onboarding/OnboardingFrame';
import { Input, TextArea } from '../src/components/ThemedInputs';
import { useToast } from '../src/components/Toast';
import { readRefusal } from '../src/lib/consentClient';
import { ensureForegroundPermission } from '../src/lib/location';
import { useSignOut } from '../src/lib/useSignOut';
import {
  type HomeChoice,
  homeCoordOf,
  initialProfileDraft,
  type ProfileDraft,
  profileStepPatch,
  WELCOME_STEP_NUMBER,
} from '../src/lib/welcomeSteps';

/**
 * **Home, then Profile** (D298; B03 §9.6 boards 11.10–11.12), the last two steps of a new or
 * re-introduced account. Which one shows is the profile's `welcomeStep`; each step's buttons
 * advance it on the server (`consent.advanceWelcome`), and the gate opens the map once it clears.
 * Both steps are optional: *Skip* only advances.
 *
 * The Home step's choice is kept here, across the step change, so the Profile step can offer the
 * picked address's town. No photo row on the phone: there is no avatar upload here yet (deferred).
 */
export default function WelcomeScreen() {
  const profile = useQuery(api.profiles.current, {});
  const signOut = useSignOut();
  const [choice, setChoice] = useState<HomeChoice>(null);
  const step = profile?.welcomeStep;

  // No step: the last one just cleared it and the gate is about to open the map — draw nothing
  // rather than flash the Home step for a frame.
  if (step === undefined) return null;
  return step === 'home' ? (
    <HomeStep choice={choice} onChoice={setChoice} onSignOut={() => void signOut()} />
  ) : (
    <ProfileStep
      choice={choice}
      visibility={profile?.profileVisibility}
      onSignOut={() => void signOut()}
    />
  );
}

/** Boards 11.10–11.11: a typed address, or the phone's location; save or skip. */
function HomeStep({
  choice,
  onChoice,
  onSignOut,
}: {
  choice: HomeChoice;
  onChoice: (choice: HomeChoice) => void;
  onSignOut: () => void;
}) {
  const toast = useToast();
  const setHome = useMutation(api.profiles.setHome);
  const advance = useMutation(api.consent.advanceWelcome);
  const [text, setText] = useState(choice?.kind === 'address' ? choice.suggestion.label : '');
  const [locating, setLocating] = useState(false);
  const [locationFailed, setLocationFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // While the suggestions are open, "or" and the location button step aside (board 11.10).
  const [listOpen, setListOpen] = useState(false);
  const copy = ONBOARDING_COPY.home;

  async function takeLocation() {
    setLocating(true);
    setLocationFailed(false);
    try {
      if (!(await ensureForegroundPermission())) {
        setLocationFailed(true);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      setText('');
      onChoice({ kind: 'location', lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch {
      setLocationFailed(true);
    } finally {
      setLocating(false);
    }
  }

  async function finish(save: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const homeCoord = homeCoordOf(choice);
      if (save && homeCoord !== null) {
        try {
          await setHome({ homeCoord });
        } catch {
          toast(copy.notSaved);
          setBusy(false);
          return;
        }
      }
      // Skipped: no home was saved, so the Profile step has no town to take from it. Cleared
      // before the advance, because the Profile step can mount before the call resolves.
      if (!save) onChoice(null);
      await advance({ from: 'home' });
    } catch (error) {
      toast(readRefusal(error).message);
      setBusy(false);
    }
  }

  return (
    <OnboardingFrame
      onSignOut={onSignOut}
      foot={
        <XStack gap="2">
          <PrimaryButton
            flex={1}
            disabled={busy || homeCoordOf(choice) === null}
            onPress={() => void finish(true)}
          >
            {copy.save}
          </PrimaryButton>
          <SecondaryButton disabled={busy} onPress={() => void finish(false)}>
            {copy.skip}
          </SecondaryButton>
        </XStack>
      }
    >
      <StepHeader
        kicker={copy.kicker}
        step={WELCOME_STEP_NUMBER.home}
        heading={copy.heading}
        lede={copy.lede}
      />
      <AddressField
        label={copy.address}
        hint={choice?.kind === 'location' ? copy.usingLocation : copy.addressHint}
        value={text}
        onValueChange={(next) => {
          setText(next);
          // Typing again un-picks: only a suggestion from the list (or the location) is saved.
          if (choice !== null) onChoice(null);
        }}
        onPick={(suggestion) => {
          setText(suggestion.label);
          onChoice({ kind: 'address', suggestion });
        }}
        onOpenChange={setListOpen}
      />
      {listOpen ? null : (
        <OtherWayIn
          located={choice?.kind === 'location'}
          locating={locating}
          failed={locationFailed}
          onLocate={() => void takeLocation()}
        />
      )}
    </OnboardingFrame>
  );
}

/** "or", then *Use my current location* and its problem line: the Home step's other way in. */
function OtherWayIn({
  located,
  locating,
  failed,
  onLocate,
}: {
  located: boolean;
  locating: boolean;
  failed: boolean;
  onLocate: () => void;
}) {
  const theme = useTheme();
  const copy = ONBOARDING_COPY.home;
  return (
    <>
      <XStack alignItems="center" gap="3">
        <Separator flex={1} borderColor="border" />
        <Text color="foregroundMuted" fontSize={13}>
          {copy.or}
        </Text>
        <Separator flex={1} borderColor="border" />
      </XStack>
      <Button
        variant="outlined"
        borderColor={located ? 'foreground' : 'border'}
        color="foreground"
        disabled={locating}
        opacity={locating ? 0.45 : 1}
        icon={
          <FontAwesomeIcon icon={faLocationCrosshairs} size={15} color={theme.foreground?.val} />
        }
        onPress={onLocate}
      >
        {copy.useLocation}
      </Button>
      {failed ? <FieldProblem>{copy.locationFailed}</FieldProblem> : null}
    </>
  );
}

/** Board 11.12, without the photo row: bio, town, and the two switches. */
function ProfileStep({
  choice,
  visibility,
  onSignOut,
}: {
  choice: HomeChoice;
  visibility: 'public' | 'private' | undefined;
  onSignOut: () => void;
}) {
  const toast = useToast();
  const updateProfile = useMutation(api.profiles.updateProfile);
  const advance = useMutation(api.consent.advanceWelcome);
  const [draft, setDraft] = useState<ProfileDraft>(() => initialProfileDraft(choice, visibility));
  const [busy, setBusy] = useState(false);
  const copy = ONBOARDING_COPY.profile;

  async function finish(save: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const patch = save ? profileStepPatch(draft, visibility) : null;
      if (patch !== null) {
        try {
          await updateProfile(patch);
        } catch {
          toast(copy.notSaved);
          setBusy(false);
          return;
        }
      }
      await advance({ from: 'profile' });
    } catch (error) {
      toast(readRefusal(error).message);
      setBusy(false);
    }
  }

  return (
    <OnboardingFrame
      onSignOut={onSignOut}
      foot={
        <XStack gap="2">
          <PrimaryButton flex={1} disabled={busy} onPress={() => void finish(true)}>
            {copy.done}
          </PrimaryButton>
          <SecondaryButton disabled={busy} onPress={() => void finish(false)}>
            {copy.skip}
          </SecondaryButton>
        </XStack>
      }
    >
      <StepHeader
        kicker={copy.kicker}
        step={WELCOME_STEP_NUMBER.profile}
        heading={copy.heading}
        lede={copy.lede}
      />
      <YStack gap="1">
        <FieldLabel>{copy.bio}</FieldLabel>
        <TextArea
          value={draft.bio}
          onChangeText={(bio) => setDraft({ ...draft, bio })}
          maxLength={BIO_MAX_LENGTH}
          accessibilityLabel={copy.bio}
          borderColor="border"
        />
      </YStack>
      <YStack gap="1">
        <FieldLabel>{copy.town}</FieldLabel>
        <Input
          value={draft.town}
          onChangeText={(town) => setDraft({ ...draft, town })}
          maxLength={TOWN_LABEL_MAX_LENGTH}
          accessibilityLabel={copy.town}
          borderColor="border"
        />
        <FieldHint>{copy.townHint}</FieldHint>
      </YStack>
      <SwitchRow
        label={copy.publicProfile}
        hint={copy.publicProfileHint}
        checked={draft.publicProfile}
        onChange={(publicProfile) => setDraft({ ...draft, publicProfile })}
      />
      <SwitchRow
        label={copy.showTown}
        hint={copy.showTownHint}
        checked={draft.showTown}
        onChange={(showTown) => setDraft({ ...draft, showTown })}
      />
    </OnboardingFrame>
  );
}

/** One labeled switch with its hint (the shape `OnIceDock`'s rows already use). */
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <XStack
      justifyContent="space-between"
      alignItems="center"
      gap="3"
      paddingTop="3"
      borderTopWidth={1}
      borderColor="border"
    >
      <YStack flex={1} gap="1">
        <Text color="foreground" fontSize={15}>
          {label}
        </Text>
        <Paragraph color="foregroundMuted" fontSize={12}>
          {hint}
        </Paragraph>
      </YStack>
      <Switch size="2" checked={checked} onCheckedChange={onChange} accessibilityLabel={label}>
        <Switch.Thumb />
      </Switch>
    </XStack>
  );
}
