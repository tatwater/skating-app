import { useAuth, useUser } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import {
  consentRefusalAction,
  KNOW_BEFORE_YOU_GO,
  KNOW_BEFORE_YOU_GO_NAME,
  KNOW_BEFORE_YOU_GO_SHA256,
  type KnowBeforeYouGoDue,
  knowBeforeYouGoDue,
  ONBOARDING_COPY,
  type WelcomeStep,
} from '@skating/core';
import { useAction, useMutation, useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { carryAccount, carryHomeTown, useEntryStore } from '@/lib/entryHold';
import { useSignOut } from '@/lib/sheetOwner';

import { toast } from '../../kit/toast';
import { currentPosition } from '../settings/currentPosition';
import {
  type AddressSuggestion,
  type SuggestFn,
  useAddressSuggestions,
} from '../settings/geocoder';
import type { LocateState } from '../settings/HomeSection';
import { ProfilePhoto } from '../settings/ProfilePhoto';
import { useProfilePhoto } from '../settings/useProfilePhoto';
import { AccountStep, type UsernameAvailability } from './AccountStep';
import { clientReport, toastRefusal } from './consentRefusal';
import { type OnboardingStep, onboardingStepShown, welcomeStepShown } from './entrySearch';
import { KnowBeforeYouGoFlow } from './KnowBeforeYouGoFlow';
import { OutdatedStep, reloadPage } from './OutdatedStep';
import { TermsFlow } from './TermsFlow';
import { AddPhotoLabel, HomeStep, type ProfileDraft, ProfileStep } from './WelcomeSteps';

/** The signed-in address, for *Signed in as* (Clerk's, before any profile exists). */
function useEmail(): string | null {
  const { user } = useUser();
  return user?.primaryEmailAddress?.emailAddress ?? null;
}

/** `value`, once it has held still for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How long the handle must hold still before the live check asks (one query per pause). */
export const USERNAME_CHECK_DEBOUNCE_MS = 300;

/**
 * The live check (`profiles.usernameAvailable`): asked once the handle has held still, and only
 * for a handle that could be one. `unknown` until it answers for the handle on screen.
 */
export function useUsernameAvailability(username: string | null): UsernameAvailability {
  const settled = useSettled(username, USERNAME_CHECK_DEBOUNCE_MS);
  const answer = useQuery(
    api.profiles.usernameAvailable,
    settled !== null && settled === username ? { username: settled } : 'skip',
  );
  if (answer === undefined || username === null || answer.username !== username) return 'unknown';
  return answer.available ? 'free' : answer.reason === 'taken' ? 'taken' : 'unknown';
}

/**
 * `/onboarding` (boards 10.1–10.5, 11.1–11.5): a new account's Account step, then its Terms step
 * at `?step=terms` with the fields carried in memory (none carried: back to the Account step).
 */
export function OnboardingPage({
  step: asked,
  onStep,
}: {
  step: OnboardingStep;
  onStep: (step: OnboardingStep, options?: { replace?: boolean }) => void;
}) {
  const email = useEmail();
  const signOut = useSignOut();
  const account = useEntryStore((s) => s.account);
  const fields = useEntryStore((s) => s.fields);
  const taken = useEntryStore((s) => s.taken);
  const held = useEntryStore((s) => s.hold === 'receipt');
  const shown = onboardingStepShown(asked, { account: account !== null, held });

  // The URL follows what draws, so Back from the Terms step is the Account step.
  useEffect(() => {
    if (shown !== asked) onStep(shown, { replace: true });
  }, [shown, asked, onStep]);

  if (shown === 'terms') {
    return (
      <TermsFlow
        account={account}
        step={ONBOARDING_COPY.terms.step}
        email={email}
        onBackToAccount={() => onStep('account')}
        onSignOut={() => void signOut()}
      />
    );
  }
  return (
    <AccountStep
      initial={fields}
      taken={taken}
      now={Date.now()}
      email={email}
      useAvailability={useUsernameAvailability}
      onContinue={(typed, draft) => {
        carryAccount(typed, draft);
        onStep('terms');
      }}
      onSignOut={() => void signOut()}
    />
  );
}

/** `/terms` (boards 10.3–10.5 for an existing account): the Terms step alone, no counter. */
export function TermsPage() {
  const email = useEmail();
  const signOut = useSignOut();
  return (
    <TermsFlow
      account={null}
      step={null}
      email={email}
      onBackToAccount={() => {}}
      onSignOut={() => void signOut()}
    />
  );
}

/** The skater's own zone, for the season card's last-answered day. */
function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * `/know-before-you-go` (boards 10.6–10.9, 10.13, 11.6–11.9, 11.13): the questions, in the flavor
 * the season rule gives — `never` straight on the first question, `season` on the season card.
 * *Continue* on all seven writes the completion; the gate moves on when the profile says so. The
 * server takes any published version of the questions, so only a tab whose words it doesn't know
 * at all is refused (`client_outdated`), and that stops on `OutdatedStep`, offering a reload.
 */
export function KnowBeforeYouGoPage() {
  const email = useEmail();
  const signOut = useSignOut();
  const analytics = useAnalytics();
  const { sessionId } = useAuth();
  const profile = useQuery(api.profiles.current, {});
  const watch = useQuery(api.consent.watchAnchor, {});
  const complete = useMutation(api.consent.completeKnowBeforeYouGo);
  const fromReceipt = useEntryStore((s) => s.questionsFromReceipt);
  const [busy, setBusy] = useState(false);
  const [outdated, setOutdated] = useState(false);

  const due: KnowBeforeYouGoDue | null | undefined =
    profile === undefined || watch === undefined || profile === null
      ? undefined
      : knowBeforeYouGoDue(
          profile.knowBeforeYouGoAt,
          watch === null ? null : { openedAt: watch.openedAt },
        );
  // The flavor this visit opened with: the completion makes the rule say "not due", and the screen
  // must hold still while the gate moves on rather than blink out.
  const [flavor, setFlavor] = useState<KnowBeforeYouGoDue | null>(null);
  if (flavor === null && due) setFlavor(due);

  if (outdated) {
    return (
      <OutdatedStep
        kicker={KNOW_BEFORE_YOU_GO_NAME}
        email={email}
        onReload={reloadPage}
        onSignOut={() => void signOut()}
      />
    );
  }
  if (flavor === null || !profile) return null;

  const onComplete = async () => {
    setBusy(true);
    try {
      await complete({
        version: KNOW_BEFORE_YOU_GO.version,
        hash: KNOW_BEFORE_YOU_GO_SHA256,
        ...clientReport(),
        ...(sessionId ? { clientSessionId: sessionId } : {}),
      });
      analytics.capture('know_before_you_go_completed', {
        flavor: flavor === 'never' ? 'first_run' : 'season',
      });
      // Busy until the gate takes the skater on.
    } catch (error) {
      setBusy(false);
      const { code } = toastRefusal(error);
      const action = consentRefusalAction(code);
      switch (action) {
        case 'outdated':
          // Words the server doesn't know: answering them again can't help. Stop, offer a reload.
          setOutdated(true);
          break;
        case 'reopen':
        case 'rearm':
        case 'account':
        case 'say':
          break;
        default: {
          const unhandled: never = action;
          throw new Error(`unhandled refusal action: ${String(unhandled)}`);
        }
      }
    }
  };

  return (
    <KnowBeforeYouGoFlow
      step={profile.welcomeStep !== undefined ? ONBOARDING_COPY.questions.step : null}
      // Straight from the receipt: the first question, never the season card.
      flavor={fromReceipt ? 'never' : flavor}
      season={
        profile.knowBeforeYouGoAt !== undefined
          ? {
              label: watch?.label ?? KNOW_BEFORE_YOU_GO_NAME,
              displayName: profile.displayName,
              lastAt: profile.knowBeforeYouGoAt,
              timeZone: localZone(),
            }
          : undefined
      }
      busy={busy}
      email={email}
      onComplete={() => void onComplete()}
      onSeasonSignOut={() => {
        analytics.capture('season_check_signed_out');
        void signOut();
      }}
      onSignOut={() => void signOut()}
    />
  );
}

/**
 * `/welcome?step=home|profile` (boards 10.10–10.12, 11.10–11.12): a new or re-introduced account's
 * last two steps. The profile's `welcomeStep` says which one draws; the URL follows it.
 */
export function WelcomePage({
  step: asked,
  onStep,
}: {
  step: WelcomeStep;
  onStep: (step: WelcomeStep, options?: { replace?: boolean }) => void;
}) {
  const profile = useQuery(api.profiles.current, {});
  const current = profile?.welcomeStep;
  const shown = welcomeStepShown(asked, current);
  useEffect(() => {
    if (current !== undefined && current !== asked) onStep(current, { replace: true });
  }, [current, asked, onStep]);
  if (!profile) return null;
  return shown === 'home' ? (
    <WelcomeHome />
  ) : (
    <WelcomeProfile
      name={profile.displayName}
      bio={profile.bio ?? ''}
      town={profile.homeTownLabel ?? ''}
      visibility={profile.profileVisibility}
    />
  );
}

/**
 * Home (boards 10.10, 10.11): a picked address or the browser's location, saved; or skipped. The
 * picked address's town rides to the Profile step (`carryHomeTown`) only while that address is the
 * one on the field: edited, skipped, or replaced by the location, it is forgotten, as on the phone.
 *
 * A location fix arrives when it arrives. While it is on its way the other buttons wait, and a fix
 * that lands after the step has moved on (another tab, the gate), after another save began, or after
 * the skater turned to a typed address, is dropped — it never overwrites a home chosen since.
 */
function WelcomeHome() {
  const email = useEmail();
  const signOut = useSignOut();
  const analytics = useAnalytics();
  const setHome = useMutation(api.profiles.setHome);
  const advance = useMutation(api.consent.advanceWelcome);
  const suggest = useAction(api.geocode.suggest) as unknown as SuggestFn;
  const [address, setAddress] = useState('');
  const [chosen, setChosen] = useState<AddressSuggestion | null>(null);
  const [locate, setLocate] = useState<LocateState>('idle');
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const lookup = useAddressSuggestions(chosen === null ? address : '', suggest);

  // What a late fix checks before it saves: the step is still here, nothing else is saving, and it
  // is the newest locate (a typed address or a newer press supersedes it).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const busy = useRef(false);
  const locating = useRef(0);
  const dropLocate = () => {
    locating.current += 1;
    setLocate((l) => (l === 'locating' ? 'idle' : l));
  };

  const save = async (coord: { lat: number; lng: number }) => {
    busy.current = true;
    setSaving(true);
    try {
      await setHome({ homeCoord: coord });
    } catch {
      busy.current = false;
      setSaving(false);
      toast({ title: ONBOARDING_COPY.home.notSaved, tone: 'bad' });
      return;
    }
    try {
      await advance({ from: 'home' });
      analytics.capture('welcome_step_finished', { step: 'home', outcome: 'saved' });
    } catch (error) {
      toastRefusal(error);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <HomeStep
      address={address}
      onAddressChange={(value) => {
        setChosen(null);
        setAddress(value);
        // The picked address is gone, and its town with it; a typed address supersedes a locate.
        carryHomeTown(null);
        dropLocate();
      }}
      lookup={lookup}
      chosen={chosen}
      onPick={(s) => {
        setChosen(s);
        setAddress(s.label);
        carryHomeTown(s.town ?? null);
        dropLocate();
      }}
      locate={locate}
      saving={saving}
      skipping={skipping}
      email={email}
      onUseLocation={() => {
        const mine = ++locating.current;
        setLocate('locating');
        currentPosition().then(
          (coord) => {
            if (!mounted.current || mine !== locating.current || busy.current) return;
            setLocate('idle');
            // Another place than the picked address: its town is not this home's.
            carryHomeTown(null);
            void save(coord);
          },
          () => {
            if (mounted.current && mine === locating.current) setLocate('failed');
          },
        );
      }}
      onSave={() => chosen && !busy.current && void save({ lat: chosen.lat, lng: chosen.lng })}
      onSkip={async () => {
        if (busy.current) return;
        busy.current = true;
        setSkipping(true);
        // Skipped: no home, so no town for the Profile step to take from it.
        carryHomeTown(null);
        dropLocate();
        try {
          await advance({ from: 'home' });
          analytics.capture('welcome_step_finished', { step: 'home', outcome: 'skipped' });
        } catch (error) {
          toastRefusal(error);
        } finally {
          busy.current = false;
          setSkipping(false);
        }
      }}
      onSignOut={() => void signOut()}
    />
  );
}

/** What *Open the map* sends to `updateProfile`: only what the step changed (§9.6). */
export function profilePatch(
  draft: ProfileDraft,
  saved: { bio: string; town: string; isPublic: boolean },
): { bio?: string; homeTownLabel?: string; profileVisibility?: 'public' | 'private' } {
  const bio = draft.bio.trim();
  const town = draft.town.trim();
  return {
    ...(bio !== saved.bio.trim() ? { bio } : {}),
    // Show my town stores nothing of its own: on, the town is the profile's; off, it isn't saved.
    ...(draft.showTown && town !== '' && town !== saved.town.trim() ? { homeTownLabel: town } : {}),
    // The switch shows the row's own visibility (public for a new account, private for a
    // re-introduced one, D298) and writes only when the skater changed it.
    ...(draft.isPublic !== saved.isPublic
      ? { profileVisibility: draft.isPublic ? ('public' as const) : ('private' as const) }
      : {}),
  };
}

function WelcomeProfile({
  name,
  bio,
  town,
  visibility,
}: {
  name: string;
  bio: string;
  town: string;
  visibility: 'public' | 'private';
}) {
  const email = useEmail();
  const signOut = useSignOut();
  const analytics = useAnalytics();
  const update = useMutation(api.profiles.updateProfile);
  const advance = useMutation(api.consent.advanceWelcome);
  const photo = useProfilePhoto();
  const homeTown = useEntryStore((s) => s.homeTown);
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    bio,
    town: town || homeTown || '',
    isPublic: visibility === 'public',
    showTown: true,
  }));
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const finish = async (outcome: 'saved' | 'skipped') => {
    const set = outcome === 'saved' ? setSaving : setSkipping;
    set(true);
    try {
      const patch =
        outcome === 'saved'
          ? profilePatch(draft, { bio, town, isPublic: visibility === 'public' })
          : {};
      if (Object.keys(patch).length > 0) {
        try {
          await update(patch);
        } catch {
          toast({ title: ONBOARDING_COPY.profile.notSaved, tone: 'bad' });
          return;
        }
      }
      await advance({ from: 'profile' });
      analytics.capture('welcome_step_finished', { step: 'profile', outcome });
    } catch (error) {
      toastRefusal(error);
    } finally {
      set(false);
    }
  };

  return (
    <ProfileStep
      photo={
        <ProfilePhoto
          name={name}
          {...photo}
          words={{ add: <AddPhotoLabel />, hint: ONBOARDING_COPY.profile.photoHint }}
        />
      }
      draft={draft}
      onDraftChange={setDraft}
      saving={saving}
      skipping={skipping}
      email={email}
      onDone={() => void finish('saved')}
      onSkip={() => void finish('skipped')}
      onSignOut={() => void signOut()}
    />
  );
}
