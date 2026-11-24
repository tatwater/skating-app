import { useAuth } from '@clerk/expo';
import { api } from '@skating/convex/api';
import {
  consentRefusalAction,
  consentRefusalMessage,
  groupTermsBlocks,
  KNOW_BEFORE_YOU_GO_NAME,
  knowBeforeYouGoDue,
  ONBOARDING_COPY,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  receiptLine,
  splitBold,
  stripBold,
  TERMS,
  TERMS_SHA256,
  termsSectionHeading,
  termsVersionLabel,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import Constants from 'expo-constants';
import { openBrowserAsync } from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  type ScrollViewInstance,
} from 'react-native';
import { Paragraph, Separator, Text, XStack, YStack } from 'tamagui';
import { appUserAgent, consentSurface, readRefusal } from '../../lib/consentClient';
import type { ReceiptGroup } from '../../lib/entryGate';
import { DOC_URLS } from '../../lib/links';
import {
  createTermsReading,
  type ScrollMetrics,
  type TermsReading,
  type TermsReadingState,
} from '../../lib/termsReading';
import { useSignOut } from '../../lib/useSignOut';
import { useToast } from '../Toast';
import { useEntrySession } from './EntrySession';
import { Kicker, OnboardingFrame, PrimaryButton, StepHeader } from './OnboardingFrame';
import { OutdatedScreen } from './OutdatedScreen';

/** The Account step's fields, carried here in memory for the acceptance to create the row. */
export interface AccountFields {
  displayName: string;
  username: string;
  dateOfBirth: number;
}

const SURFACE = consentSurface(Platform.OS);
const USER_AGENT = appUserAgent(
  Platform.OS,
  Platform.Version,
  Constants.expoConfig?.version ?? '0.0.1',
);

/**
 * **The Terms step** (B03 §9.6 boards 11.2–11.5), for a new account inside `app/onboarding.tsx` and
 * for an existing one alone in `app/terms.tsx`. The terms are read on the page itself, a hairline
 * under the bar filling with the scroll; the agree line unlocks once the end marker has been on
 * screen *and the server has stamped it*; *Record acceptance* records it; then the receipt, under
 * the root's hold, with the *Next: Know Before You Go* block only when the questions are due.
 *
 * Refusals are toasts (D268). Some also act, by core's `consentRefusalAction`: a refusal about the
 * Account fields (`username_taken`, the cooldown, a name, username or date the server won't take)
 * returns a new account to the Account step, `terms_not_read` re-arms the end marker (on the opening
 * it has), a failed opening is tried again quietly as the skater scrolls, an end reached while an
 * opening is out waits for its answer (the reading's first opening counts on success; a retry's
 * answer starts over), a reading the server doesn't have at the end (`terms_not_opened`, or an
 * opening that never succeeded — said in `terms_not_opened`'s words, or in the server's own when it
 * refused the account as unable to act) starts again from the top and its end counts only once
 * reached again (`lib/termsReading`, as on the web), and
 * `client_outdated` — this build's terms or notice aren't the server's, which no re-reading fixes —
 * stops the step on `OutdatedScreen`, asking for an update; nothing re-arms after it.
 */
export function TermsStep({
  account,
  showStep,
  heldOn,
  onAccountRefused,
}: {
  /** A new or re-introduced account's fields; `null` for an existing account. */
  account: AccountFields | null;
  showStep: boolean;
  heldOn: ReceiptGroup;
  /** A refusal about the Account fields: the new account goes back to fix them. */
  onAccountRefused?: (code: string, username: string) => void;
}) {
  const [recorded, setRecorded] = useState(false);
  const [outdated, setOutdated] = useState(false);
  const signOut = useSignOut();
  if (outdated) {
    return <OutdatedScreen kicker={ONBOARDING_COPY.terms.kicker} onSignOut={signOut} />;
  }
  return recorded ? (
    <Receipt showStep={showStep} onSignOut={signOut} />
  ) : (
    <Reader
      account={account}
      showStep={showStep}
      heldOn={heldOn}
      onRecorded={() => setRecorded(true)}
      onOutdated={() => setOutdated(true)}
      onSignOut={signOut}
      onAccountRefused={onAccountRefused}
    />
  );
}

function Reader({
  account,
  showStep,
  heldOn,
  onRecorded,
  onOutdated,
  onSignOut,
  onAccountRefused,
}: {
  account: AccountFields | null;
  showStep: boolean;
  heldOn: ReceiptGroup;
  onRecorded: () => void;
  /** `client_outdated`: the step stops on the update notice. */
  onOutdated: () => void;
  onSignOut: () => void;
  onAccountRefused?: (code: string, username: string) => void;
}) {
  const { sessionId } = useAuth();
  const { dispatch } = useEntrySession();
  const toast = useToast();
  const openTerms = useMutation(api.consent.openTerms);
  const reachTermsEnd = useMutation(api.consent.reachTermsEnd);
  const acceptTerms = useMutation(api.consent.acceptTerms);

  const [state, setState] = useState<TermsReadingState>({ end: 'unseen', progress: 0 });
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const metrics = useRef<ScrollMetrics>({ offsetY: 0, viewportHeight: 0, contentHeight: 0 });
  const markerY = useRef<number | null>(null);

  // The calls change identity only with the client. The controller is made in the effect (not a
  // memo) so a remount always gets a live one.
  const calls = useRef({ openTerms, reachTermsEnd, toast });
  calls.current = { openTerms, reachTermsEnd, toast };
  const readingRef = useRef<TermsReading | null>(null);
  useEffect(() => {
    const reading = createTermsReading({
      open: () =>
        calls.current.openTerms({
          termsVersion: TERMS.version,
          termsHash: TERMS_SHA256,
          surface: SURFACE,
        }),
      reach: () =>
        calls.current.reachTermsEnd({
          termsVersion: TERMS.version,
          termsHash: TERMS_SHA256,
          via: 'inline',
        }),
      onRefusal: (error) => calls.current.toast(readRefusal(error).message),
      // The end reached with no opening on the server (each retry failed too): why, then the top.
      onUnopened: () => calls.current.toast(consentRefusalMessage('terms_not_opened')),
      onChange: setState,
      // A reading started again is read from the top. The marker stays where it was laid out (the
      // same text), so its position is kept.
      toTop: () => scrollRef.current?.scrollTo({ y: 0, animated: false }),
    });
    readingRef.current = reading;
    reading.start();
    return () => {
      reading.dispose();
      readingRef.current = null;
    };
  }, []);

  // The opening or the end refused as out of date: final, and the step stops.
  const outdated = state.end === 'outdated';
  useEffect(() => {
    if (outdated) onOutdated();
  }, [outdated, onOutdated]);

  const observe = () => readingRef.current?.observe(metrics.current, markerY.current);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    metrics.current = {
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
      contentHeight: contentSize.height,
    };
    observe();
  };
  const onLayout = (e: LayoutChangeEvent) => {
    metrics.current = { ...metrics.current, viewportHeight: e.nativeEvent.layout.height };
    observe();
  };
  const onContentSizeChange = (_w: number, h: number) => {
    metrics.current = { ...metrics.current, contentHeight: h };
    observe();
  };
  const onMarkerLayout = (e: LayoutChangeEvent) => {
    markerY.current = e.nativeEvent.layout.y;
    observe();
  };

  const unlocked = state.end === 'recorded';
  const canRecord = unlocked && checked && !busy;

  async function onRecord() {
    if (!canRecord) return;
    setBusy(true);
    // Held before the call: the new profile can reach the gate before this call resolves.
    dispatch({ type: 'accepted', on: heldOn });
    try {
      await acceptTerms({
        termsVersion: TERMS.version,
        termsHash: TERMS_SHA256,
        privacyVersion: PRIVACY_NOTICE_VERSION,
        privacyHash: PRIVACY_NOTICE_SHA256,
        surface: SURFACE,
        userAgent: USER_AGENT,
        ...(sessionId ? { clientSessionId: sessionId } : {}),
        ...(account ? { account } : {}),
      });
      onRecorded();
    } catch (error) {
      dispatch({ type: 'acceptFailed' });
      const refusal = readRefusal(error);
      toast(refusal.message);
      const action = consentRefusalAction(refusal.code);
      if (account && onAccountRefused && action === 'account') {
        onAccountRefused(refusal.code as string, account.username);
        setBusy(false);
        return;
      }
      switch (action) {
        case 'outdated':
          onOutdated();
          return;
        case 'reopen':
          // From the top, and the end counts once it is reached again (the reading's rule).
          setChecked(false);
          readingRef.current?.restart();
          break;
        case 'rearm':
          setChecked(false);
          readingRef.current?.rearm();
          break;
        // An existing account has no Account step: its toast is all there is.
        case 'account':
        case 'say':
          break;
        default: {
          const unhandled: never = action;
          throw new Error(`unhandled refusal action: ${String(unhandled)}`);
        }
      }
      setBusy(false);
    }
  }

  const agree = ONBOARDING_COPY.terms.agree;
  return (
    <OnboardingFrame
      onSignOut={onSignOut}
      progress={state.progress}
      scrollRef={scrollRef}
      scrollProps={{ onScroll, onLayout, onContentSizeChange, scrollEventThrottle: 32 }}
      foot={
        <>
          <XStack gap="3" alignItems="flex-start" opacity={unlocked ? 1 : 0.5}>
            <Text
              color={checked ? 'primary' : 'foregroundMuted'}
              fontSize={22}
              lineHeight={24}
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled: !unlocked }}
              accessibilityLabel={`${agree.before}${agree.link}${agree.after}`}
              disabled={!unlocked}
              onPress={() => setChecked((c) => !c)}
              hitSlop={12}
            >
              {checked ? '☑' : '☐'}
            </Text>
            <Paragraph
              flex={1}
              color="foreground"
              fontSize={14}
              disabled={!unlocked}
              onPress={() => setChecked((c) => !c)}
            >
              {agree.before}
              {/* The one link: the notice is read, never scroll-gated. */}
              <Text
                color="primary"
                textDecorationLine="underline"
                accessibilityRole="link"
                onPress={() => void openBrowserAsync(DOC_URLS.privacy)}
              >
                {agree.link}
              </Text>
              {agree.after}
            </Paragraph>
          </XStack>
          <PrimaryButton disabled={!canRecord} onPress={() => void onRecord()}>
            {ONBOARDING_COPY.terms.submit}
          </PrimaryButton>
        </>
      }
    >
      <StepHeader
        kicker={ONBOARDING_COPY.terms.kicker}
        step={showStep ? ONBOARDING_COPY.terms.step : null}
        heading={ONBOARDING_COPY.terms.heading}
        lede={ONBOARDING_COPY.terms.lede}
      />
      <Text color="foregroundMuted" fontSize={12} letterSpacing={0.5}>
        {unlocked
          ? `${termsVersionLabel()} · ${ONBOARDING_COPY.terms.readToEnd}`
          : termsVersionLabel()}
      </Text>
      {TERMS.sections.map((section, i) => (
        <YStack key={section.heading} gap="2" marginTop="2">
          <Text
            color="foreground"
            fontSize={13}
            fontWeight="700"
            letterSpacing={1.2}
            textTransform="uppercase"
            accessibilityRole="header"
          >
            {termsSectionHeading(i, section)}
          </Text>
          {groupTermsBlocks(section.blocks).map((run, j) =>
            run.kind === 'p' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the terms are fixed data; order is identity
              <TermsText key={j} text={run.text} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above
              <YStack key={j} gap="1-5">
                {run.items.map((item) => (
                  <XStack key={item} gap="2" alignItems="flex-start">
                    <Paragraph color="foreground">•</Paragraph>
                    <TermsText text={item} flex={1} />
                  </XStack>
                ))}
              </YStack>
            ),
          )}
        </YStack>
      ))}
      <XStack alignItems="center" gap="3" marginTop="4" marginBottom="2" onLayout={onMarkerLayout}>
        <Separator flex={1} borderColor="border" />
        <Text color="foregroundMuted" fontSize={12} fontFamily="mono">
          {ONBOARDING_COPY.terms.endMarker}
        </Text>
        <Separator flex={1} borderColor="border" />
      </XStack>
    </OnboardingFrame>
  );
}

/** A paragraph of the terms, its `**bold**` spans bold — the same marks the email renders. */
function TermsText({ text, flex }: { text: string; flex?: number }) {
  return (
    <Paragraph color="foreground" flex={flex} accessibilityLabel={stripBold(text)}>
      {splitBold(text).map((span, i) =>
        span.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans of one fixed string
          <Text key={i} fontWeight="700" color="foreground">
            {span.text}
          </Text>
        ) : (
          span.text
        ),
      )}
    </Paragraph>
  );
}

/**
 * *Acceptance recorded* (board 11.5): where the copy went, then — only when the questions are due —
 * what they are, and the button that releases the hold.
 */
function Receipt({ showStep, onSignOut }: { showStep: boolean; onSignOut: () => void }) {
  const { dispatch } = useEntrySession();
  const receipt = useQuery(api.consent.latestTermsReceipt, {});
  const profile = useQuery(api.profiles.current, {});
  const anchor = useQuery(api.consent.watchAnchor, {});

  const due =
    profile != null &&
    knowBeforeYouGoDue(profile.knowBeforeYouGoAt, anchor ? { openedAt: anchor.openedAt } : null) !==
      null;
  // Pending with no address yet says nothing: the send may still find one. Otherwise core decides.
  const line =
    receipt == null || (receipt.copy === 'pending' && !receipt.email)
      ? null
      : receiptLine(receipt.copy, receipt.email);
  const next = ONBOARDING_COPY.next;

  return (
    <OnboardingFrame
      onSignOut={onSignOut}
      foot={
        <PrimaryButton
          // Wait for the profile, so the button never says one thing and does another.
          disabled={profile === undefined || anchor === undefined}
          onPress={() => dispatch({ type: 'released', startQuestions: due })}
        >
          {due ? ONBOARDING_COPY.receipt.start : ONBOARDING_COPY.receipt.continue}
        </PrimaryButton>
      }
    >
      <StepHeader
        kicker={ONBOARDING_COPY.receipt.kicker}
        step={showStep ? ONBOARDING_COPY.terms.step : null}
        heading={ONBOARDING_COPY.receipt.heading}
        lede={
          line === null ? undefined : line.kind === 'sent' ? (
            <Paragraph color="foregroundMuted">
              {line.before}
              <Text color="foreground">{line.email}</Text>
              {line.after}
            </Paragraph>
          ) : (
            line.text
          )
        }
      />
      {due ? (
        <YStack gap="3">
          <Separator borderColor="border" />
          <Kicker>{next.kicker}</Kicker>
          <Paragraph
            color="foreground"
            accessibilityLabel={`${KNOW_BEFORE_YOU_GO_NAME}. ${next.body}`}
          >
            {next.body}
          </Paragraph>
          <YStack>
            {next.how.map((how, i) => (
              <XStack
                key={how}
                gap="3"
                paddingVertical="2-5"
                borderBottomWidth={i < next.how.length - 1 ? 1 : 0}
                borderColor="border"
              >
                <Text color="foregroundMuted" width={16}>
                  {i + 1}
                </Text>
                <Paragraph flex={1} color="foreground">
                  {how}
                </Paragraph>
              </XStack>
            ))}
          </YStack>
        </YStack>
      ) : null}
    </OnboardingFrame>
  );
}
