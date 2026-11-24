import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faLocationCrosshairs } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import { BIO_MAX_LENGTH, ONBOARDING_COPY, TOWN_LABEL_MAX_LENGTH } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { type ReactNode, useReducer, useState } from 'react';
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
import { readRefusal, readSaveRefusal } from '../src/lib/consentClient';
import { useLocateRead } from '../src/lib/useLocateRead';
import { useSignOut } from '../src/lib/useSignOut';
import {
  EMPTY_HOME_FIELD,
  type HomeChoice,
  type HomeField,
  type HomeFieldEvent,
  homeCoordOf,
  homeFieldReducer,
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
  // The Home step's field and its choice, kept here across the step change so the Profile step can
  // offer the picked address's town.
  const [home, onHome] = useReducer(homeFieldReducer, EMPTY_HOME_FIELD);
  const step = profile?.welcomeStep;

  // No step: the last one just cleared it and the gate is about to open the map — draw nothing
  // rather than flash the Home step for a frame.
  if (step === undefined) return null;
  return step === 'home' ? (
    <HomeStep home={home} onHome={onHome} onSignOut={() => void signOut()} />
  ) : (
    <ProfileStep
      choice={home.choice}
      visibility={profile?.profileVisibility}
      onSignOut={() => void signOut()}
    />
  );
}

/** Boards 11.10–11.11: a typed address, or the phone's location; save or skip. */
function HomeStep({
  home,
  onHome,
  onSignOut,
}: {
  home: HomeField;
  onHome: (event: HomeFieldEvent) => void;
  onSignOut: () => void;
}) {
  const { text, choice } = home;
  const toast = useToast();
  const setHome = useMutation(api.profiles.setHome);
  const advance = useMutation(api.consent.advanceWelcome);
  const [busy, setBusy] = useState(false);
  // While the suggestions are open, "or" and the location button step aside (board 11.10).
  const [listOpen, setListOpen] = useState(false);
  const copy = ONBOARDING_COPY.home;

  // A fix is taken only when it is the newest read and the skater hasn't typed, picked, saved or
  // skipped since (core's `createLocateRead`, as on the web): a late fix never replaces a choice.
  const {
    locate,
    start: startLocate,
    supersede,
  } = useLocateRead(({ lat, lng }) => onHome({ type: 'located', lat, lng }));

  async function finish(save: boolean) {
    if (busy) return;
    setBusy(true);
    // Saved or skipped: a location still being read is dropped.
    supersede();
    try {
      const homeCoord = homeCoordOf(choice);
      if (save && homeCoord !== null) {
        try {
          await setHome({ homeCoord });
        } catch (error) {
          // The server's own "can't act" is said in its words; anything else is the not-saved line.
          toast(readSaveRefusal(error, copy.notSaved).message);
          setBusy(false);
          return;
        }
      }
      // Skipped: no home was saved, so the Profile step has no town to take from it, and the field
      // lets go of the address with it (`homeFieldReducer`'s `skipped`, as the web's does). Cleared
      // before the advance, because the Profile step can mount before the call resolves.
      if (!save) onHome({ type: 'skipped' });
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
          // Typing again un-picks, and a location still being read gives way to the typing.
          onHome({ type: 'typed', text: next });
          supersede();
        }}
        onPick={(suggestion) => {
          onHome({ type: 'picked', suggestion });
          supersede();
        }}
        onOpenChange={setListOpen}
      />
      {listOpen ? null : (
        <OtherWayIn
          located={choice?.kind === 'location'}
          locating={locate === 'locating'}
          busy={busy}
          failed={locate === 'failed'}
          onLocate={startLocate}
        />
      )}
    </OnboardingFrame>
  );
}

/**
 * "or", then *Use my current location* and its problem line: the Home step's other way in. The
 * button waits while a save or a skip is out (`busy`), as the web's does: a read begun then would
 * outlive the save that superseded the ones before it.
 */
function OtherWayIn({
  located,
  locating,
  busy,
  failed,
  onLocate,
}: {
  located: boolean;
  locating: boolean;
  busy: boolean;
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
        disabled={locating || busy}
        opacity={locating || busy ? 0.45 : 1}
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
        } catch (error) {
          // The server's own "can't act" is said in its words; anything else is the not-saved line.
          toast(readSaveRefusal(error, copy.notSaved).message);
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
