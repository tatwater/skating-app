import { useAuth } from '@clerk/expo';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faCheck, faXmark } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import {
  deviceTimeZone,
  KNOW_BEFORE_YOU_GO,
  KNOW_BEFORE_YOU_GO_SHA256,
  knowBeforeYouGoAnswers,
  knowBeforeYouGoDue,
  ONBOARDING_COPY,
  questionsLastAnswered,
  seasonCardLede,
  TERMS,
  termsUnchangedSince,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import Constants from 'expo-constants';
import { useReducer, useState } from 'react';
import { Platform } from 'react-native';
import { Paragraph, Text, useTheme, XStack, YStack } from 'tamagui';
import { useEntrySession } from '../src/components/onboarding/EntrySession';
import {
  OnboardingFrame,
  PrimaryButton,
  SecondaryButton,
  StepHeader,
} from '../src/components/onboarding/OnboardingFrame';
import { useToast } from '../src/components/Toast';
import { appUserAgent, consentSurface, readRefusal } from '../src/lib/consentClient';
import {
  answerLook,
  canAdvance,
  initialQuiz,
  isLastQuestion,
  type QuizEvent,
  type QuizState,
  quizCells,
  quizReducer,
} from '../src/lib/knowBeforeYouGoQuiz';
import { useSignOut } from '../src/lib/useSignOut';

const QUESTIONS = KNOW_BEFORE_YOU_GO.questions;
const SURFACE = consentSurface(Platform.OS);
const USER_AGENT = appUserAgent(
  Platform.OS,
  Platform.Version,
  Constants.expoConfig?.version ?? '0.0.1',
);

/**
 * **Know Before You Go** (D296; B03 §9.6 boards 11.6–11.9 and 11.13): seven questions, one at a
 * time, two answers each in the data's order. A miss is explained and the button waits for the
 * right pick; the last answer shows the "All seven" list, whose *Continue* writes the completion —
 * the only thing the server ever hears about the questions. Wrong picks are never stored.
 *
 * A skater answering again for a new season opens on *A new season on the ice*, with *Not now —
 * sign out* as the way out (no bar on that card). Reached when the gate says `questions`; the gate
 * moves on by itself once the completion lands.
 */
export default function KnowBeforeYouGoScreen() {
  const { session } = useEntrySession();
  const profile = useQuery(api.profiles.current, {});
  const anchor = useQuery(api.consent.watchAnchor, {});
  const signOut = useSignOut();

  // The gate only routes here once both have loaded, so the opening is decided once, on arrival.
  const [quiz, send] = useReducer(
    (state: QuizState, event: QuizEvent) => quizReducer(QUESTIONS, state, event),
    null,
    () =>
      initialQuiz(
        profile
          ? knowBeforeYouGoDue(
              profile.knowBeforeYouGoAt,
              anchor ? { openedAt: anchor.openedAt } : null,
            )
          : 'never',
        session.questionsFromReceipt,
      ),
  );

  if (quiz.phase === 'season') {
    return (
      <SeasonCard
        label={anchor?.label ?? ''}
        displayName={profile?.displayName ?? ''}
        lastAt={profile?.knowBeforeYouGoAt}
        onStart={() => send({ type: 'start' })}
        onSignOut={() => void signOut()}
      />
    );
  }
  if (quiz.phase === 'done') {
    return (
      <AllSeven
        showStep={session.accountSeen}
        onSignOut={() => void signOut()}
        onRestart={() => send({ type: 'restart' })}
      />
    );
  }
  return (
    <Question
      quiz={quiz}
      showStep={session.accountSeen}
      onPick={(answer) => send({ type: 'pick', answer })}
      onNext={() => send({ type: 'next' })}
      onSignOut={() => void signOut()}
    />
  );
}

/** Board 11.13: the season's name, a welcome back, and what's unchanged and what's due. */
function SeasonCard({
  label,
  displayName,
  lastAt,
  onStart,
  onSignOut,
}: {
  label: string;
  displayName: string;
  lastAt: number | undefined;
  onStart: () => void;
  onSignOut: () => void;
}) {
  const copy = ONBOARDING_COPY.season;
  const rows: Array<[string, string]> = [[copy.termsRow, termsUnchangedSince(TERMS.version)]];
  if (lastAt !== undefined) {
    rows.push([copy.questionsRow, questionsLastAnswered(lastAt, deviceTimeZone() ?? 'UTC')]);
  }
  return (
    <OnboardingFrame
      foot={
        <>
          <PrimaryButton onPress={onStart}>{copy.start}</PrimaryButton>
          <SecondaryButton onPress={onSignOut}>{copy.signOut}</SecondaryButton>
        </>
      }
    >
      <StepHeader
        kicker={label}
        step={null}
        heading={copy.heading}
        lede={seasonCardLede(displayName)}
      />
      <YStack borderTopWidth={1} borderColor="border">
        {rows.map(([name, value]) => (
          <XStack
            key={name}
            paddingVertical="2-5"
            gap="3"
            alignItems="center"
            borderBottomWidth={1}
            borderColor="border"
          >
            <Text flex={1} color="foregroundMuted" fontSize={14}>
              {name}
            </Text>
            <Text color="foreground" fontSize={13} fontFamily="mono" textAlign="right">
              {value}
            </Text>
          </XStack>
        ))}
      </YStack>
    </OnboardingFrame>
  );
}

/** The seven cells across the top: answered, the one on screen, still ahead. */
function Cells({ quiz }: { quiz: QuizState }) {
  return (
    <XStack
      gap="1"
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: QUESTIONS.length, now: quiz.index + 1 }}
    >
      {quizCells(QUESTIONS.length, quiz).map((cell, i) => (
        <YStack
          // biome-ignore lint/suspicious/noArrayIndexKey: seven fixed cells
          key={i}
          flex={1}
          height={4}
          backgroundColor={cell === 'ahead' ? 'border' : 'primary'}
          opacity={cell === 'current' ? 0.7 : 1}
        />
      ))}
    </XStack>
  );
}

/** Boards 11.6–11.8: the question, its two answers, and the line under them. */
function Question({
  quiz,
  showStep,
  onPick,
  onNext,
  onSignOut,
}: {
  quiz: QuizState;
  showStep: boolean;
  onPick: (answer: 0 | 1) => void;
  onNext: () => void;
  onSignOut: () => void;
}) {
  const theme = useTheme();
  const question = QUESTIONS[quiz.index];
  if (!question) return null;
  const answers = knowBeforeYouGoAnswers(question);
  const copy = ONBOARDING_COPY.questions;
  const last = isLastQuestion(QUESTIONS, quiz);

  return (
    <OnboardingFrame
      onSignOut={onSignOut}
      foot={
        <PrimaryButton disabled={!canAdvance(quiz)} onPress={onNext}>
          {last ? copy.finish : copy.next}
        </PrimaryButton>
      }
    >
      <StepHeader kicker={copy.kicker} step={showStep ? copy.step : null} />
      <Cells quiz={quiz} />
      <Text
        color="foreground"
        fontSize={22}
        lineHeight={28}
        fontWeight="700"
        accessibilityRole="header"
      >
        {question.prompt}
      </Text>
      <YStack gap="2">
        {answers.map((answer, i) => {
          const slot = i as 0 | 1;
          const look = answerLook(quiz, slot);
          return (
            <XStack
              key={answer.text}
              padding="3"
              gap="3"
              alignItems="center"
              borderWidth={1}
              borderColor={look === 'miss' ? 'warning' : look === 'right' ? 'foreground' : 'border'}
              backgroundColor="press:surfaceMuted"
              accessibilityRole="button"
              accessibilityState={{ selected: look !== 'plain' }}
              onPress={() => onPick(slot)}
            >
              <Paragraph flex={1} color={look === 'miss' ? 'foregroundMuted' : 'foreground'}>
                {answer.text}
              </Paragraph>
              {look === 'miss' ? (
                <FontAwesomeIcon icon={faXmark} size={16} color={theme.warning?.val} />
              ) : look === 'right' ? (
                <FontAwesomeIcon icon={faCheck} size={16} color={theme.foreground?.val} />
              ) : null}
            </XStack>
          );
        })}
      </YStack>
      {/* The feedback line's room is kept before a pick, so the answers never jump. */}
      <XStack gap="2" minHeight={72} alignItems="flex-start" accessibilityLiveRegion="polite">
        {quiz.outcome !== 'none' ? (
          <>
            <YStack
              width={8}
              height={8}
              marginTop={7}
              backgroundColor={quiz.outcome === 'miss' ? 'warning' : 'primary'}
            />
            <Paragraph flex={1} color="foreground" fontSize={14}>
              <Text fontWeight="700" color="foreground">
                {quiz.outcome === 'miss' ? copy.notQuite : copy.correct}
              </Text>{' '}
              {question.why}
              {quiz.outcome === 'miss' ? ` ${copy.pickCorrect}` : ''}
            </Paragraph>
          </>
        ) : null}
      </XStack>
    </OnboardingFrame>
  );
}

/** Board 11.9: the seven lines, and the *Continue* that records the completion. */
function AllSeven({
  showStep,
  onSignOut,
  onRestart,
}: {
  showStep: boolean;
  onSignOut: () => void;
  onRestart: () => void;
}) {
  const { sessionId } = useAuth();
  const theme = useTheme();
  const toast = useToast();
  const complete = useMutation(api.consent.completeKnowBeforeYouGo);
  const [busy, setBusy] = useState(false);
  const copy = ONBOARDING_COPY.done;

  async function onContinue() {
    if (busy) return;
    setBusy(true);
    try {
      await complete({
        version: KNOW_BEFORE_YOU_GO.version,
        hash: KNOW_BEFORE_YOU_GO_SHA256,
        surface: SURFACE,
        userAgent: USER_AGENT,
        ...(sessionId ? { clientSessionId: sessionId } : {}),
      });
      // The gate moves on as the profile updates; nothing to navigate.
    } catch (error) {
      const refusal = readRefusal(error);
      toast(refusal.message);
      if (refusal.code === 'questions_changed') onRestart();
      setBusy(false);
    }
  }

  return (
    <OnboardingFrame
      onSignOut={onSignOut}
      foot={
        <PrimaryButton disabled={busy} onPress={() => void onContinue()}>
          {copy.continue}
        </PrimaryButton>
      }
    >
      <StepHeader
        kicker={copy.kicker}
        step={showStep ? copy.step : null}
        heading={copy.heading}
        lede={copy.lede}
      />
      <YStack>
        {QUESTIONS.map((q, i) => (
          <XStack
            key={q.id}
            gap="3"
            paddingVertical="2-5"
            alignItems="flex-start"
            borderBottomWidth={i < QUESTIONS.length - 1 ? 1 : 0}
            borderColor="border"
          >
            <YStack paddingTop={4}>
              <FontAwesomeIcon icon={faCheck} size={14} color={theme.primary?.val} />
            </YStack>
            <Paragraph flex={1} color="foreground">
              {q.say}
            </Paragraph>
          </XStack>
        ))}
      </YStack>
    </OnboardingFrame>
  );
}
