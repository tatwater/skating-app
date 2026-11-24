import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck } from '@fortawesome/sharp-light-svg-icons';
import {
  KNOW_BEFORE_YOU_GO,
  type KnowBeforeYouGoDue,
  knowBeforeYouGoAnswers,
  ONBOARDING_COPY,
  questionsLastAnswered,
  seasonCardLede,
  TERMS,
  termsUnchangedSince,
} from '@skating/core';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';
import { ENTRY_PRIMARY, EntryHead, EntryScreen, WIDE } from './EntryScreen';
import { QuestionCard, QuestionCells, type QuestionState } from './QuestionCard';

const QUESTIONS = KNOW_BEFORE_YOU_GO.questions;
const LAST = QUESTIONS.length - 1;

/** Where the flow stands: the season card, a question, or all seven. */
export interface KnowBeforeYouGoPosition {
  stage: 'season' | 'question' | 'done';
  /** The question on screen (0-based). */
  index: number;
  state: QuestionState;
}

/** Where a flavor opens: the season card for `season`, straight on the first question for `never`. */
export function openingPosition(flavor: KnowBeforeYouGoDue): KnowBeforeYouGoPosition {
  return { stage: flavor === 'season' ? 'season' : 'question', index: 0, state: 'ask' };
}

/** A pick on the question at `position`: the right one settles it, the other is a miss. */
export function pickAnswer(
  position: KnowBeforeYouGoPosition,
  pick: 0 | 1,
): KnowBeforeYouGoPosition {
  const question = QUESTIONS[position.index];
  if (position.stage !== 'question' || !question || position.state === 'right') return position;
  const right = knowBeforeYouGoAnswers(question)[pick].right;
  if (!right && position.state === 'miss') return position;
  return { ...position, state: right ? 'right' : 'miss' };
}

/** *Next question* (or *Finish* on the seventh): only once the right answer is picked. */
export function advance(position: KnowBeforeYouGoPosition): KnowBeforeYouGoPosition {
  if (position.stage !== 'question' || position.state !== 'right') return position;
  if (position.index >= LAST) return { stage: 'done', index: LAST, state: 'right' };
  return { stage: 'question', index: position.index + 1, state: 'ask' };
}

/** Whether a key press belongs to something that types (where 1, 2 and Enter mean themselves). */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export interface SeasonFacts {
  /** The season card's kicker: "Winter 2027–28". */
  label: string;
  displayName: string;
  /** When the questions were last answered (epoch ms). */
  lastAt: number;
  /** The skater's zone, for that day. */
  timeZone: string;
}

/**
 * **Know Before You Go** (boards 10.6–10.9, 10.13, 11.6–11.9, 11.13; D296): "you know this, we're
 * just making sure". One question at a time, seven cells for how far; a miss explains and waits for
 * the right pick; after the seventh, all seven as the skater would say them, and *Continue* — the
 * one write (`onComplete`). Nothing about a pick leaves this component: the answers are local
 * state, and a wrong one is stored nowhere.
 *
 * On a desk, keys 1 and 2 pick and Enter goes on once the right one is picked (the button takes
 * focus then, so Enter is its own press). The `season` flavor opens on *A new season on the ice*,
 * whose second button signs out.
 */
export function KnowBeforeYouGoFlow({
  step,
  flavor,
  season,
  initial,
  busy,
  email,
  onComplete,
  onSeasonSignOut,
  onSignOut,
  className,
}: {
  /** "3 of 5" for an account new this session, else `null`. */
  step: number | null;
  flavor: KnowBeforeYouGoDue;
  /** The season card's facts (`season` flavor). */
  season?: SeasonFacts;
  /** A board's position; the flavor's opening otherwise. */
  initial?: KnowBeforeYouGoPosition;
  /** The completion is on its way. */
  busy: boolean;
  email: string | null;
  onComplete: () => void;
  onSeasonSignOut: () => void;
  onSignOut: () => void;
  className?: string;
}) {
  const [position, setPosition] = useState<KnowBeforeYouGoPosition>(
    () => initial ?? openingPosition(flavor),
  );
  const firstPick = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);

  const pick = (i: 0 | 1) => setPosition((p) => pickAnswer(p, i));
  const go = () => setPosition(advance);

  // A settled question hands focus to its button, so Enter goes on; a new one to its first answer.
  const settled = position.stage === 'question' && position.state === 'right';
  // biome-ignore lint/correctness/useExhaustiveDependencies: the position is the trigger
  useEffect(() => {
    if (settled) next.current?.focus();
  }, [settled, position.index]);
  const moved = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the question's index is the trigger
  useEffect(() => {
    // Not on the first render: the page opens where the skater's eye is, not on an answer.
    if (moved.current && position.stage === 'question') firstPick.current?.focus();
    moved.current = true;
  }, [position.index, position.stage]);

  // Keys 1 and 2, and Enter, on a desk.
  const live = useRef({ position, busy });
  live.current = { position, busy };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target)) return;
      const now = live.current.position;
      if (now.stage !== 'question') return;
      if (event.key === '1' || event.key === '2') {
        event.preventDefault();
        setPosition((p) => pickAnswer(p, event.key === '1' ? 0 : 1));
        return;
      }
      // Enter on a focused button is that button's own press; elsewhere it goes on.
      if (event.key === 'Enter' && now.state === 'right') {
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, a')) return;
        event.preventDefault();
        setPosition(advance);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (position.stage === 'season' && season) {
    return (
      <SeasonCard
        season={season}
        email={email}
        className={className}
        onStart={() => setPosition({ stage: 'question', index: 0, state: 'ask' })}
        onSignOut={onSeasonSignOut}
        onBarSignOut={onSignOut}
      />
    );
  }

  const copy = ONBOARDING_COPY;
  if (position.stage === 'done') {
    return (
      <EntryScreen
        width="questions"
        className={className}
        email={email}
        onSignOut={onSignOut}
        head={
          <EntryHead kicker={copy.done.kicker} step={step} title={copy.done.heading}>
            {copy.done.lede}
          </EntryHead>
        }
        actions={
          <Button
            variant="primary"
            autoFocus
            loading={busy}
            className={cn(ENTRY_PRIMARY, WIDE)}
            onClick={() => !busy && onComplete()}
            data-attr="know-before-you-go-continue"
          >
            {copy.done.continue}
          </Button>
        }
      >
        <ul data-slot="all-seven" className="m-0 flex list-none flex-col p-0">
          {QUESTIONS.map((q) => (
            <li
              key={q.id}
              className="flex items-start gap-3 border-0 border-line2 border-b border-dotted py-[0.6875rem] text-[0.90625rem] text-fg leading-[1.4] last:border-b-0"
            >
              <FontAwesomeIcon
                icon={faCheck}
                aria-hidden="true"
                className="mt-1 h-3 flex-none text-acc"
              />
              <span>{q.say}</span>
            </li>
          ))}
        </ul>
      </EntryScreen>
    );
  }

  const question = QUESTIONS[position.index] ?? QUESTIONS[0];
  const answered = position.state === 'right' ? position.index + 1 : position.index;
  return (
    <EntryScreen
      width="questions"
      className={className}
      email={email}
      onSignOut={onSignOut}
      head={<EntryHead kicker={copy.questions.kicker} step={step} />}
      actions={
        <Button
          ref={next}
          variant="primary"
          disabled={position.state !== 'right'}
          className={cn(ENTRY_PRIMARY, WIDE)}
          onClick={go}
          data-attr={position.index >= LAST ? 'question-finish' : 'question-next'}
        >
          {position.index >= LAST ? copy.questions.finish : copy.questions.next}
        </Button>
      }
    >
      <QuestionCells answered={answered} />
      {question && (
        <QuestionCard ref={firstPick} question={question} state={position.state} onPick={pick} />
      )}
    </EntryScreen>
  );
}

/**
 * **A new season on the ice** (boards 10.13, 11.13): a returning skater's first sign-in after the
 * Ice Watch opens a season. The two rows say what's on file — the terms unchanged since their
 * version's day, the questions' last-answered day in the skater's own zone (the founder reviewed
 * that day on screen; it is the skater's own, not one of the terms' stamps). *Start the questions*,
 * or *Not now — sign out*: the card's way out, so it has no *Signed in as* foot on a desk.
 */
export function SeasonCard({
  season,
  email,
  onStart,
  onSignOut,
  onBarSignOut,
  className,
}: {
  season: SeasonFacts;
  email: string | null;
  onStart: () => void;
  /** *Not now — sign out*. */
  onSignOut: () => void;
  /** The phone bar's *Sign out*. */
  onBarSignOut: () => void;
  className?: string;
}) {
  const copy = ONBOARDING_COPY.season;
  const rows = [
    { label: copy.termsRow, value: termsUnchangedSince(TERMS.version) },
    { label: copy.questionsRow, value: questionsLastAnswered(season.lastAt, season.timeZone) },
  ];
  return (
    <EntryScreen
      width="season"
      className={className}
      email={email}
      foot={false}
      onSignOut={onBarSignOut}
      head={
        <EntryHead kicker={season.label} title={copy.heading}>
          {seasonCardLede(season.displayName)}
        </EntryHead>
      }
      actions={
        <>
          <Button
            variant="primary"
            autoFocus
            className={cn(ENTRY_PRIMARY, WIDE)}
            onClick={onStart}
            data-attr="season-start-questions"
          >
            {copy.start}
          </Button>
          <Button className={WIDE} onClick={onSignOut} data-attr="season-sign-out">
            {copy.signOut}
          </Button>
        </>
      }
    >
      <dl
        data-slot="season-rows"
        className="m-0 flex flex-col border-0 border-line border-t border-solid"
      >
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex min-h-[2.875rem] items-center gap-3 border-0 border-line border-b border-solid text-[0.90625rem] text-fg1 last:border-b-0"
          >
            <dt>{row.label}</dt>
            <dd className="m-0 ml-auto whitespace-nowrap font-(family-name:--family-mono) font-medium text-[0.75rem] text-fg leading-none">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </EntryScreen>
  );
}
